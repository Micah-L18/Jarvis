import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDevice, deviceOptions } from '../src/renderer/devices.js';
import { Voice } from '../src/renderer/voice.js';

const dev = (kind, deviceId, label = '') => ({ kind, deviceId, label });
const plugged = [
  dev('audioinput', 'default', 'Default - Built-in Microphone'),
  dev('audioinput', 'mic-1', 'Built-in Microphone'),
  dev('audioinput', 'mic-2', 'USB Headset'),
  dev('videoinput', 'cam-1', 'Camera'),
  dev('audiooutput', 'default', 'Default'),
  dev('audiooutput', 'out-1', 'Speakers'),
];

test('devices: a saved choice is used while plugged in, the system default while it is not', () => {
  assert.equal(resolveDevice(plugged, 'audioinput', ''), '');
  assert.equal(resolveDevice(plugged, 'audioinput', 'mic-2'), 'mic-2');
  assert.equal(resolveDevice(plugged, 'audioinput', 'mic-gone'), '');
  assert.equal(resolveDevice(plugged, 'audiooutput', 'mic-2'), '', 'a microphone is not a speaker');
  // No ids to go on (permission not granted yet, or nothing listed): try the saved device as it is.
  assert.equal(resolveDevice([dev('audioinput', '')], 'audioinput', 'mic-2'), 'mic-2');
  assert.equal(resolveDevice([], 'audiooutput', 'out-1'), 'out-1');
});

test('devices: select options put the system default first and keep an unplugged saved device visible', () => {
  assert.deepEqual(deviceOptions(plugged, 'audioinput', 'mic-2'), [['', 'System default — Built-in Microphone'], ['mic-1', 'Built-in Microphone'], ['mic-2', 'USB Headset']]);
  assert.deepEqual(deviceOptions(plugged, 'audiooutput'), [['', 'System default'], ['out-1', 'Speakers']]);
  assert.deepEqual(deviceOptions(plugged, 'audiooutput', 'out-gone').at(-1), ['out-gone', 'Saved device — not connected']);
  // Ids without names are numbered; entries without ids cannot be chosen at all.
  assert.deepEqual(deviceOptions([dev('audioinput', 'a'), dev('audioinput', 'b')], 'audioinput'), [['', 'System default'], ['a', 'Microphone 1'], ['b', 'Microphone 2']]);
  assert.deepEqual(deviceOptions([dev('audiooutput', '')], 'audiooutput', 'out-1'), [['', 'System default'], ['out-1', 'Saved device']]);
});

// The Voice's device rules, with the browser parts (opening a stream, the audio context) stood in for.
function fakeVoice({ opens = () => true } = {}) {
  const said = [];
  const voice = new Voice({ onStatus: (t) => said.push(`error: ${t}`), onNotice: (t) => said.push(t), onState: () => {}, settings: () => ({}) });
  const log = [];
  voice._openMic = async (id) => {
    log.push(`open ${id || 'default'}`);
    if (!opens(id)) throw new Error('Requested device not found');
    voice.micId = id;
    voice.micOn = true;
  };
  const ctx = { state: 'running', setSinkId: async (id) => { log.push(`sink ${id || 'default'}`); if (id === 'out-broken') throw new Error('not found'); } };
  voice._ctx = () => ctx;
  return { voice, said, log };
}

test('voice: a missing saved microphone falls back to the default, says so once, and is used again when it returns', async () => {
  const { voice, said, log } = fakeVoice();
  voice.devices = plugged;
  await voice._useMic('mic-gone');
  await voice._useMic('mic-gone');
  assert.deepEqual(log, ['open default']);
  assert.equal(voice.micOn, true);
  assert.deepEqual(said, ['The saved microphone is not available. Using the system default.']);

  voice.devices = [...plugged, dev('audioinput', 'mic-gone', 'Desk Microphone')];
  await voice._useMic('mic-gone');
  assert.deepEqual(log, ['open default', 'open mic-gone']);
  assert.deepEqual(said.slice(1), ['The saved microphone is back. Using it again.']);
});

test('voice: a listed microphone that will not open leaves the default in use; no microphone at all is reported once', async () => {
  const busy = fakeVoice({ opens: (id) => id !== 'mic-2' });
  busy.voice.devices = plugged;
  await busy.voice._useMic('mic-2');
  await busy.voice._useMic('mic-2'); // tried again, but the default is not reopened
  assert.deepEqual(busy.log, ['open mic-2', 'open default', 'open mic-2']);
  assert.equal(busy.voice.micId, '');
  assert.equal(busy.said.length, 1);

  const none = fakeVoice({ opens: () => false });
  await none.voice._useMic('mic-2');
  await none.voice._useMic('mic-2');
  assert.equal(none.voice.micOn, false);
  assert.deepEqual(none.said, ['error: Microphone unavailable (Requested device not found). You can still type.']);
});

test('voice: the speaker follows the saved choice and falls back to the default when it cannot be used', async () => {
  const { voice, said, log } = fakeVoice();
  voice.devices = plugged;
  await voice._useSpeaker('out-1');
  await voice._useSpeaker('out-1');
  assert.deepEqual(log, ['sink out-1']);
  await voice._useSpeaker('out-gone');
  assert.deepEqual(log, ['sink out-1', 'sink default']);
  assert.deepEqual(said, ['The saved speaker is not available. Using the system default.']);
  voice.devices = [];
  await voice._useSpeaker('out-broken'); // nothing listed: tried as saved, refused, default kept
  assert.equal(voice.sinkId, '');
  assert.equal(said.length, 2);
});
