// Choosing a microphone and a speaker from what the system reports (enumerateDevices).
// No window needed here, so the rules can be tested on their own.

const WORD = { audioinput: 'Microphone', audiooutput: 'Speaker' };

// Without permission the browser lists devices with empty ids; those cannot be chosen.
const usable = (devices, kind) => (devices || []).filter((d) => d.kind === kind && d.deviceId);

/**
 * The device id to open for a saved choice ('' = system default): the saved device while it is
 * plugged in, the system default while it is not. If the system will not say what is plugged in,
 * the saved id is returned to be tried as it is.
 */
export function resolveDevice(devices, kind, saved) {
  if (!saved) return '';
  const list = usable(devices, kind);
  return !list.length || list.some((d) => d.deviceId === saved) ? saved : '';
}

/** [id, label] pairs for a select: the system default first, then each device, then a saved one that is unplugged. */
export function deviceOptions(devices, kind, saved = '') {
  const list = usable(devices, kind);
  // Chromium lists the default as its own entry ("Default - Built-in Microphone"); fold it into ours.
  const named = (list.find((d) => d.deviceId === 'default')?.label || '').replace(/^default\s*[-–—:]\s*/i, '').trim();
  const options = [['', named && !/^default$/i.test(named) ? `System default — ${named}` : 'System default']];
  list.filter((d) => d.deviceId !== 'default').forEach((d, i) => options.push([d.deviceId, d.label || `${WORD[kind]} ${i + 1}`]));
  if (saved && !options.some(([id]) => id === saved)) options.push([saved, list.length ? 'Saved device — not connected' : 'Saved device']);
  return options;
}
