(function (root) {
  'use strict';
  // Mirrors runner-v2.js buildShimScript defaults. No widget source is executed.
  const SHIM_DEFAULTS = {
    ampTheme: 'onkyo', needleDamping: 95, meterSensitivity: 5, showPeakHold: false,
    sensorLeft: 'left', sensorRight: 'right', attackSpeed: 95, decaySpeed: 18,
    inputGain: 100, colorTheme: 'rainbow', barCount: 64, sensitivity: 100,
    smoothing: 75, barGap: 1, glowIntensity: 70, peakHold: true, mirrorMode: false,
    showReflection: true, barRounding: true, weatherLocation: 5368361,
    textColor: '#ffffff', accentColor: '#ffffff', backgroundColor: '#000000',
    backgroundImage: '', bgBrightness: 100, glassBlur: 0, transparency: 80,
    openMeteoApiKey: '', allowMicrophoneFallback: false
  };
  const IDS = { 'com.meloyellowjr.vumeter': 'vu', 'com.meloyellowjr.spectrumanalyzer': 'spectrum', 'com.corsair.airquality': 'aqi', 'com.corsair.widget.doodle-pad': 'doodle', 'com.shocksim.robextourbillon': 'clock' };
  function getWidgetKind(widget) { return IDS[widget?.id || widget?.manifest?.id] || 'generic'; }
  function getDefaultWidgetSettings(widget) {
    const kind = getWidgetKind(widget);
    const defaults = { ...SHIM_DEFAULTS };
    if (kind === 'vu') Object.assign(defaults, { textColor: '#e8e8e8', accentColor: '#c8a84b', backgroundColor: '#141414', transparency: 100 });
    if (kind === 'spectrum') Object.assign(defaults, { accentColor: '#7b2fff', transparency: 100 });
    if (kind === 'doodle') Object.assign(defaults, { backgroundColor: '#4b4b4b', transparency: 100, color1: '#785aff', color2: '#b9ed2d', color3: '#e6027d', color4: '#1ecfdf', color5: '#fac800' });
    if (kind === 'clock') Object.assign(defaults, { showSeconds: true, showTourbillon: true, showDate: true, showMonthDial: true, secondHandColor: '#cc0000' });
    return defaults;
  }
  const range = (name, label, min, max, step = 1) => ({ name, label, type: 'range', min, max, step });
  const checkbox = (name, label) => ({ name, label, type: 'checkbox' });
  const color = (name, label) => ({ name, label, type: 'color' });
  const text = (name, label) => ({ name, label, type: 'text' });
  function getSettingDefinitions(widget) {
    const kind = getWidgetKind(widget);
    if (kind === 'generic') return [];
    let specific = [];
    if (kind === 'vu') specific = [text('ampTheme', 'Amplifier theme'), range('needleDamping', 'Needle damping', 10, 99), range('meterSensitivity', 'Meter sensitivity', 2, 12), checkbox('showPeakHold', 'Peak hold'), range('attackSpeed', 'Needle attack', 10, 99), range('decaySpeed', 'Needle decay', 2, 40), range('inputGain', 'Input gain', 10, 200)];
    if (kind === 'spectrum') specific = [range('inputGain', 'Input gain', 10, 300, 5), range('sensitivity', 'Sensitivity', 10, 200, 5), range('smoothing', 'Smoothing', 0, 95), checkbox('peakHold', 'Peak hold'), checkbox('mirrorMode', 'Mirror mode')];
    if (kind === 'doodle') specific = [color('color1', 'Color 1'), color('color2', 'Color 2'), color('color3', 'Color 3'), color('color4', 'Color 4'), color('color5', 'Color 5')];
    if (kind === 'clock') specific = [checkbox('showSeconds', 'Show second hand'), checkbox('showTourbillon', 'Show tourbillon'), checkbox('showDate', 'Show date'), checkbox('showMonthDial', 'Show month dial'), color('secondHandColor', 'Second hand color')];
    // AQI location is a framework search-combobox, deliberately not emulated.
    return [...specific, color('textColor', 'Text color'), color('accentColor', 'Accent color'), color('backgroundColor', 'Background color'), range('transparency', 'Background transparency', kind === 'aqi' ? 1 : 0, 100), ...(kind === 'aqi' ? [] : [range('glassBlur', 'Glass blur', 0, kind === 'doodle' ? 20 : 30)])];
  }
  const api = { getWidgetKind, getSettingDefinitions, getDefaultWidgetSettings };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ICUEWidgetSettings = api;
})(typeof globalThis === 'object' ? globalThis : this);
