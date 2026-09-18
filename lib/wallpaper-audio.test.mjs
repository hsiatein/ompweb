import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { spectrumBands, audioUniformSpectrum } = await jiti.import('./wallpaper-audio.ts');
const { parseWallpaperPreferences } = await jiti.import('./wallpapers.ts');
test('audio preferences default to audible and preserve bounded volume independently of mute', () => {
  const defaults = parseWallpaperPreferences(null);
  assert.equal(defaults.volume, 50); assert.equal(defaults.muted, false); assert.equal(defaults.paused, false);
  assert.equal(parseWallpaperPreferences('{"volume":-5}').volume, 0);
  assert.equal(parseWallpaperPreferences('{"volume":999}').volume, 100);
  assert.equal(parseWallpaperPreferences('{"volume":"5"}').volume, 50);
  assert.equal(parseWallpaperPreferences('{"volume":35,"muted":true}').volume, 35);
});
test('FFT uses ordered logarithmic bands and bounded normalized magnitudes', () => {
  assert.deepEqual(spectrumBands(new Uint8Array(1024), 48000, 2048), Array(64).fill(0));
  const bins = new Uint8Array(1024); bins[43] = 255;
  const bands = spectrumBands(bins, 48000, 2048);
  assert.equal(bands.length, 64); assert.ok(bands.some(n => n === 1));
  assert.ok(bands.slice(0, 20).every(n => n === 0));
  assert.ok(bands.every(n => n >= 0 && n <= 1));
});
test('shader spectra retain stereo channel and downsample every source bin', () => {
  const stereo = [...Array(64).fill(.25), ...Array(64).fill(.75)];
  assert.deepEqual(audioUniformSpectrum('g_AudioSpectrum16Left', stereo), Array(16).fill(.25));
  assert.deepEqual(audioUniformSpectrum('g_AudioSpectrum32Right', stereo), Array(32).fill(.75));
  assert.deepEqual(audioUniformSpectrum('g_AudioSpectrum64', stereo), Array(64).fill(.5));
  assert.equal(audioUniformSpectrum('g_Time', stereo), undefined);
});
