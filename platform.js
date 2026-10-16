(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NotchPlatform = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function capabilities(platform) {
    return {
      platform,
      unavailableHomeModules: platform === 'darwin' ? [] : ['windows'],
      automaticPaste: platform === 'darwin',
      autoLaunch: platform === 'darwin' || platform === 'win32',
    };
  }

  function effectiveHiddenModules(hidden, registry, unavailable) {
    const available = registry.filter((id) => !unavailable.includes(id));
    const result = registry.filter((id) => hidden.includes(id) || unavailable.includes(id));
    // A workspace moved from Mac may have only unavailable widgets visible.
    if (available.length && available.every((id) => result.includes(id))) {
      return result.filter((id) => id !== available[0]);
    }
    return result;
  }

  function panelBounds(platform, display, expanded) {
    const area = platform === 'win32' ? display.workArea : display.bounds;
    const strip = platform === 'win32' ? 38 : Math.max(0, display.workArea.y - display.bounds.y) || 38;
    const width = expanded ? Math.max(1, Math.min(1240, display.workArea.width - (platform === 'win32' ? 48 : 24))) : Math.min(200, area.width);
    const height = expanded ? Math.min(616, Math.max(strip, area.height - 24)) : strip;
    return { x: Math.round(area.x + (area.width - width) / 2), y: area.y, width, height };
  }
  function portableMediaPath(directory, value) {
    return `${directory}/${String(value).replace(/\\/g, '/').split('/').pop()}`;
  }
  return { capabilities, effectiveHiddenModules, panelBounds, portableMediaPath };
});
