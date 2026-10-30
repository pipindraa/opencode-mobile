const { withAndroidManifest } = require("expo/config-plugins");

/** Разрешает plain HTTP (наш сервер на ноуте через Tailscale, без TLS). */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    if (!manifest.manifest.application || manifest.manifest.application.length === 0) {
      manifest.manifest.application = [{}];
    }
    const app = manifest.manifest.application[0];
    app.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
};
