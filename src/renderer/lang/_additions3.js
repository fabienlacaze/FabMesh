/* FabMesh i18n - capability-based image-engine labels (user-chosen 2026-06-21).
 * Load AFTER lang/_additions2.js. */
(function () {
  if (!window.FabI18n || !window.FabI18n.register) return;
  window.FabI18n.register('fr', {
    'Balanced (quality/speed)': 'Équilibré (qualité/vitesse)',
    'Max quality (HD · slower)': 'Qualité max (HD · plus lent)',
    'Fast (Turbo ⚡ · ~4 steps)': 'Rapide (Turbo ⚡ · ~4 étapes)',
  });
  window.FabI18n.register('es', {
    'Balanced (quality/speed)': 'Equilibrado (calidad/velocidad)',
    'Max quality (HD · slower)': 'Calidad máxima (HD · más lento)',
    'Fast (Turbo ⚡ · ~4 steps)': 'Rápido (Turbo ⚡ · ~4 pasos)',
  });
  window.FabI18n.register('zh', {
    'Balanced (quality/speed)': '均衡（质量/速度）',
    'Max quality (HD · slower)': '最高质量（HD · 较慢）',
    'Fast (Turbo ⚡ · ~4 steps)': '快速（Turbo ⚡ · 约4步）',
  });
  window.FabI18n.register('hi', {
    'Balanced (quality/speed)': 'संतुलित (गुणवत्ता/गति)',
    'Max quality (HD · slower)': 'अधिकतम गुणवत्ता (HD · धीमा)',
    'Fast (Turbo ⚡ · ~4 steps)': 'तेज़ (Turbo ⚡ · ~4 स्टेप)',
  });
  window.FabI18n.register('ar', {
    'Balanced (quality/speed)': 'متوازن (الجودة/السرعة)',
    'Max quality (HD · slower)': 'أعلى جودة (HD · أبطأ)',
    'Fast (Turbo ⚡ · ~4 steps)': 'سريع (Turbo ⚡ · ~4 خطوات)',
  });
  try { window.FabI18n.applyLang(window.FabI18n.lang); } catch (_) {}
})();
