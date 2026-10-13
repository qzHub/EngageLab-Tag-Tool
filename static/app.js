const $ = (id) => document.getElementById(id);
const idsBox = $("registrationIds");
const actionButtons = [$("bindTag"), $("verifyTag")];
const encoder = new TextEncoder();
const MAX_IDS = 100_000;
const BATCH_SIZE = 1_000;
const VERIFY_WORKERS = 10;
let lastBoundIds = [];

function uniqueRegistrationIds(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const id = value.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function registrationIds() {
  return uniqueRegistrationIds(idsBox.value.split(/\r?\n/));
}

function csvToIds(text) {
  const rows = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => {
    let value = line.split(",", 1)[0].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/""/g, '"');
    }
    return value;
  }).filter(Boolean);

  if (rows[0] && ["registration_id", "registration id", "registrationid"].includes(rows[0].toLowerCase())) {
    rows.shift();
  }
  return uniqueRegistrationIds(rows);
}

function updateCount() {
  $("idCount").textContent = `${registrationIds().length} 个 registration ID`;
}

function basicAuthorization(appKey, masterSecret) {
  const bytes = encoder.encode(`${appKey}:${masterSecret}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function validateInput() {
  const ids = registrationIds();
  const config = {
    apiBase: $("apiBase").value,
    appKey: $("appKey").value.trim(),
    masterSecret: $("masterSecret").value.trim(),
    tag: $("tag").value.trim(),
    ids
  };

  if (!config.appKey) throw new Error("AppKey 不能为空");
  if (!config.masterSecret) throw new Error("Master Secret 不能为空");
  if (!config.tag) throw new Error("Tag 不能为空");
  if (encoder.encode(config.tag).length > 40) throw new Error("Tag 的 UTF-8 长度不能超过 40 字节");
  if (!/^[A-Za-z0-9_\u3400-\u9fff]+$/u.test(config.tag)) {
    throw new Error("Tag 只能包含字母、数字、下划线和中文字符");
  }
  if (!ids.length) throw new Error("请输入至少一个 registration ID");
  if (ids.length > MAX_IDS) throw new Error(`一次最多处理 ${MAX_IDS.toLocaleString()} 个 registration ID`);
  const longIdIndex = ids.findIndex((id) => encoder.encode(id).length > 255);
  if (longIdIndex >= 0) throw new Error(`第 ${longIdIndex + 1} 个 registration ID 过长`);
  return config;
}

async function fetchWithTimeout(url, options, timeout = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(text, fallback) {
  try {
    const payload = JSON.parse(text);
    const error = payload?.error;
    if (error?.message) return error.code == null ? String(error.message) : `${error.code}: ${error.message}`;
  } catch (_) {
    // Preserve the original response text when it is not JSON.
  }
  return text.trim() || fallback;
}

function invalidRegistrationIds(text) {
  try {
    const payload = JSON.parse(text);
    let data = payload?.error?.data;
    if (typeof data === "string") data = JSON.parse(data);
    return Array.isArray(data?.invalid_regids) ? data.invalid_regids.map(String) : [];
  } catch (_) {
    return [];
  }
}

async function bindTag(config) {
  const endpoint = `${config.apiBase}/v4/tags/${encodeURIComponent(config.tag)}`;
  const authorization = basicAuthorization(config.appKey, config.masterSecret);
  const results = [];

  for (let start = 0; start < config.ids.length; start += BATCH_SIZE) {
    const ids = config.ids.slice(start, start + BATCH_SIZE);
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ registration_ids: { add: ids } })
      });
      const text = await response.text();
      results.push({
        batch: results.length + 1,
        count: ids.length,
        success: response.ok,
        status: response.status,
        message: response.ok ? (text.trim() || "success") : errorMessage(text, response.statusText),
        invalid_registration_ids: response.ok ? [] : invalidRegistrationIds(text)
      });
    } catch (error) {
      results.push({
        batch: results.length + 1,
        count: ids.length,
        success: false,
        status: null,
        message: error.name === "AbortError" ? "请求超时" : `网络请求失败：${error.message || error}`,
        invalid_registration_ids: []
      });
    }
  }

  const successCount = results.filter((item) => item.success).reduce((sum, item) => sum + item.count, 0);
  return {
    total: config.ids.length,
    batch_size: BATCH_SIZE,
    batches: results.length,
    success_count: successCount,
    failed_count: config.ids.length - successCount,
    results
  };
}

async function verifyTagBindings(config) {
  const authorization = basicAuthorization(config.appKey, config.masterSecret);
  const tagPath = encodeURIComponent(config.tag);
  const results = new Array(config.ids.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= config.ids.length) return;
      const registrationId = config.ids[index];
      const endpoint = `${config.apiBase}/v4/tags/${tagPath}/registration_ids/${encodeURIComponent(registrationId)}`;
      try {
        const response = await fetchWithTimeout(endpoint, {
          method: "GET",
          headers: { Authorization: authorization, Accept: "application/json" }
        });
        const text = await response.text();
        if (!response.ok) {
          results[index] = { registration_id: registrationId, bound: null, status: response.status, message: errorMessage(text, response.statusText) };
          continue;
        }
        let payload;
        try {
          payload = JSON.parse(text);
        } catch (_) {
          results[index] = { registration_id: registrationId, bound: null, status: response.status, message: "EngageLab 返回了无法解析的响应" };
          continue;
        }
        if (typeof payload?.result !== "boolean") {
          results[index] = { registration_id: registrationId, bound: null, status: response.status, message: "响应中缺少布尔类型的 result 字段" };
          continue;
        }
        results[index] = { registration_id: registrationId, bound: payload.result, status: response.status, message: payload.result ? "已绑定" : "未绑定" };
      } catch (error) {
        results[index] = {
          registration_id: registrationId,
          bound: null,
          status: null,
          message: error.name === "AbortError" ? "请求超时" : `网络请求失败：${error.message || error}`
        };
      }
    }
  }

  const workers = Array.from({ length: Math.min(VERIFY_WORKERS, config.ids.length) }, () => worker());
  await Promise.all(workers);
  const boundIds = results.filter((item) => item.bound === true).map((item) => item.registration_id);
  const unboundIds = results.filter((item) => item.bound === false).map((item) => item.registration_id);
  const errors = results.filter((item) => item.bound === null);
  return {
    total: config.ids.length,
    bound_count: boundIds.length,
    unbound_count: unboundIds.length,
    error_count: errors.length,
    bound_registration_ids: boundIds,
    unbound_registration_ids: unboundIds,
    errors
  };
}

function downloadCsv(name, ids) {
  const content = `\uFEFFregistration_id\r\n${ids.join("\r\n")}\r\n`;
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function addPill(text) {
  const item = document.createElement("span");
  item.className = "pill";
  item.textContent = text;
  $("summary").appendChild(item);
}

function showResult(mode, data) {
  $("result").hidden = false;
  $("summary").replaceChildren();
  $("boundList").hidden = true;
  $("downloadBound").hidden = true;

  if (mode === "bind") {
    addPill(`总数 ${data.total}`);
    addPill(`成功 ${data.success_count}`);
    addPill(`失败 ${data.failed_count}`);
    addPill(`批次 ${data.batches}`);
    $("details").textContent = JSON.stringify(data.results, null, 2);
    return;
  }

  lastBoundIds = data.bound_registration_ids;
  addPill(`总数 ${data.total}`);
  addPill(`已绑定 ${data.bound_count}`);
  addPill(`未绑定 ${data.unbound_count}`);
  addPill(`查询失败 ${data.error_count}`);
  $("boundList").hidden = false;
  $("boundList").value = lastBoundIds.join("\n");
  $("downloadBound").hidden = lastBoundIds.length === 0;
  $("details").textContent = data.errors.length ? JSON.stringify(data.errors, null, 2) : "查询完成，没有接口错误。";
}

async function run(mode) {
  let config;
  try {
    config = validateInput();
  } catch (error) {
    $("status").className = "error";
    $("status").textContent = error.message;
    return;
  }

  actionButtons.forEach((button) => button.disabled = true);
  $("status").className = "";
  $("status").textContent = mode === "bind" ? "正在批量设置……" : "正在查询……";
  try {
    const result = mode === "bind" ? await bindTag(config) : await verifyTagBindings(config);
    showResult(mode, result);
    $("status").className = "ok";
    $("status").textContent = "处理完成";
  } catch (error) {
    $("status").className = "error";
    $("status").textContent = error.message || String(error);
  } finally {
    actionButtons.forEach((button) => button.disabled = false);
  }
}

idsBox.addEventListener("input", updateCount);
$("clearIds").addEventListener("click", () => {
  idsBox.value = "";
  updateCount();
});
$("csvFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const ids = csvToIds(await file.text());
    idsBox.value = ids.join("\n");
    updateCount();
    $("status").className = "ok";
    $("status").textContent = `已导入 ${ids.length} 个 ID`;
  } catch (error) {
    $("status").className = "error";
    $("status").textContent = `读取 CSV 失败：${error.message || error}`;
  } finally {
    event.target.value = "";
  }
});
$("downloadBound").addEventListener("click", () => downloadCsv("bound-registration-ids.csv", lastBoundIds));
$("bindTag").addEventListener("click", () => run("bind"));
$("verifyTag").addEventListener("click", () => run("verify"));
updateCount();
