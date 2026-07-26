// inject/ua-spoof.js — MAIN world: override navigator.userAgent + userAgentData
// Injected dynamically by ua.js when a UA override is active.
// Receives target UA string via __captainUATarget global set before injection.
//
// v5 fix: userAgentData is now a proper object that satisfies the
// NavigatorUAData interface more completely, including:
//   • platform / platformVersion / architecture / bitness / model
//   • fullVersionList aligned with brands
//   • uaFullVersion derived from the UA string
// This closes the gap where sites using getHighEntropyValues() would see
// inconsistent values between navigator.userAgent and navigator.userAgentData.
(function () {
  'use strict';
  const ua = window.__captainUATarget;
  if (!ua) return;

  // ── navigator.userAgent ────────────────────────────────────────────────────
  try {
    Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
  } catch {}

  // ── Parse the UA string into structured CH data ───────────────────────────
  function parseUA(uaString) {
    let brands   = [{ brand: 'Not/A)Brand', version: '8' }];
    let mobile   = /mobile/i.test(uaString);
    let platform = 'Windows';
    let platformVersion = '10.0.0';
    let architecture    = 'x86';
    let bitness         = '64';
    let model           = '';

    if (/macintosh|mac os x/i.test(uaString)) {
      platform = 'macOS';
      const mv = uaString.match(/Mac OS X ([\d_]+)/i);
      platformVersion = mv ? mv[1].replace(/_/g, '.') : '14.0.0';
      architecture = 'arm'; // modern Macs are arm by default assumption
    }
    if (/linux/i.test(uaString) && !/android/i.test(uaString)) {
      platform = 'Linux'; platformVersion = ''; architecture = 'x86'; bitness = '64';
    }
    if (/android/i.test(uaString)) {
      platform = 'Android'; mobile = true;
      const av = uaString.match(/Android ([\d.]+)/i);
      platformVersion = av ? av[1] : '13';
      const mm = uaString.match(/;\s*([^;)]+)\s*\)/);
      model = mm ? mm[1].trim() : '';
      architecture = ''; bitness = '';
    }
    if (/iphone/i.test(uaString)) {
      platform = 'iOS'; mobile = true;
      const iv = uaString.match(/iPhone OS ([\d_]+)/i);
      platformVersion = iv ? iv[1].replace(/_/g, '.') : '17.0';
      model = 'iPhone'; architecture = 'arm'; bitness = '64';
    }
    if (/ipad/i.test(uaString)) {
      platform = 'iOS'; mobile = false;
      const iv = uaString.match(/OS ([\d_]+)/i);
      platformVersion = iv ? iv[1].replace(/_/g, '.') : '17.0';
      model = 'iPad'; architecture = 'arm'; bitness = '64';
    }

    // Build brands list: always include "Not/A)Brand", Chromium, and the
    // identified browser if present.
    const chromeMajor = (uaString.match(/Chrome\/([\d]+)/) || [])[1];
    const edgeMajor   = (uaString.match(/Edg\/([\d]+)/)    || [])[1];

    if (chromeMajor) {
      brands = [
        { brand: 'Not/A)Brand',   version: '8'          },
        { brand: 'Chromium',      version: chromeMajor  },
        ...(edgeMajor
          ? [{ brand: 'Microsoft Edge', version: edgeMajor }]
          : [{ brand: 'Google Chrome',  version: chromeMajor }]),
      ];
    }

    const fullVersionList = brands.map(b => ({ brand: b.brand, version: b.version + '.0.0.0' }));
    const uaFullVersion   = chromeMajor ? `${chromeMajor}.0.0.0` : '';

    return { brands, mobile, platform, platformVersion, architecture, bitness, model,
             fullVersionList, uaFullVersion };
  }

  const parsed = parseUA(ua);

  // ── navigator.userAgentData ───────────────────────────────────────────────
  // Construct an object matching the NavigatorUAData Web IDL interface.
  const uaData = Object.create(null);

  // Low-entropy properties (synchronous)
  Object.defineProperties(uaData, {
    brands:   { get: () => parsed.brands,  enumerable: true },
    mobile:   { get: () => parsed.mobile,  enumerable: true },
    platform: { get: () => parsed.platform, enumerable: true },
    // getHighEntropyValues — asynchronous, returns all requested hints
    getHighEntropyValues: {
      value: async (hints) => {
        const out = {};
        const map = {
          brands:          parsed.brands,
          mobile:          parsed.mobile,
          platform:        parsed.platform,
          platformVersion: parsed.platformVersion,
          architecture:    parsed.architecture,
          bitness:         parsed.bitness,
          model:           parsed.model,
          fullVersionList: parsed.fullVersionList,
          uaFullVersion:   parsed.uaFullVersion,
        };
        for (const h of hints) if (h in map) out[h] = map[h];
        return out;
      },
      enumerable: true,
    },
    toJSON: {
      value: () => ({ brands: parsed.brands, mobile: parsed.mobile, platform: parsed.platform }),
      enumerable: false,
    },
  });

  try {
    Object.defineProperty(navigator, 'userAgentData', { get: () => uaData, configurable: true });
  } catch {}
})();
