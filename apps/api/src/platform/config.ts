function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function config() {
  return {
    internalServiceToken: required("INTERNAL_SERVICE_TOKEN"),
    internalHmacSecret: required("INTERNAL_HMAC_SECRET"),
    sessionSecret: required("SESSION_SECRET"),
    appBaseUrl: required("APP_BASE_URL"),
  };
}
