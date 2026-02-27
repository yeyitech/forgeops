const PRODUCT_TYPE_SET = new Set([
  "web",
  "miniapp",
  "ios",
  "microservice",
  "android",
  "serverless",
  "other",
]);

const PRODUCT_TYPE_LABELS = {
  web: "WEB应用",
  miniapp: "微信小程序",
  ios: "IOS APP",
  microservice: "微服务后端",
  android: "Android APP",
  serverless: "Serverless 后端",
  other: "其他类型",
};

const PRODUCT_TYPE_ALIASES = {
  web: "web",
  "web_app": "web",
  "webapp": "web",
  "web应用": "web",
  "web application": "web",
  miniapp: "miniapp",
  "wechat_miniapp": "miniapp",
  "wechat-miniapp": "miniapp",
  "mini app": "miniapp",
  "mini-app": "miniapp",
  "微信小程序": "miniapp",
  ios: "ios",
  "ios app": "ios",
  "ios_app": "ios",
  "ios应用": "ios",
  "ios application": "ios",
  microservice: "microservice",
  "micro-service": "microservice",
  "micro service": "microservice",
  "microservice backend": "microservice",
  "微服务": "microservice",
  "微服务后端": "microservice",
  "python microservice": "microservice",
  android: "android",
  "android app": "android",
  "android_app": "android",
  "android应用": "android",
  "android application": "android",
  serverless: "serverless",
  "server-less": "serverless",
  "serverless backend": "serverless",
  "faas": "serverless",
  "函数计算": "serverless",
  "无服务器": "serverless",
  other: "other",
  "其他": "other",
  "其他类型": "other",
};

export function normalizeProductType(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const normalized = PRODUCT_TYPE_ALIASES[raw.toLowerCase()] ?? null;
  if (!normalized) return null;
  return PRODUCT_TYPE_SET.has(normalized) ? normalized : null;
}

export function getProductTypeLabel(type) {
  const normalized = normalizeProductType(type);
  if (!normalized) return String(type ?? "");
  return PRODUCT_TYPE_LABELS[normalized] ?? normalized;
}

export function listSupportedProductTypes() {
  return [
    { value: "web", label: PRODUCT_TYPE_LABELS.web },
    { value: "miniapp", label: PRODUCT_TYPE_LABELS.miniapp },
    { value: "ios", label: PRODUCT_TYPE_LABELS.ios },
    { value: "microservice", label: PRODUCT_TYPE_LABELS.microservice },
    { value: "android", label: PRODUCT_TYPE_LABELS.android },
    { value: "serverless", label: PRODUCT_TYPE_LABELS.serverless },
    { value: "other", label: PRODUCT_TYPE_LABELS.other },
  ];
}
