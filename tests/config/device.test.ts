import { describe, expect, test } from 'bun:test';
import {
  AppSettingsSchema,
  DeviceConfigSchema,
  deriveDeviceName,
  generateRandomDeviceName,
} from '../../src/config/index.js';

describe('Device identity & name derivation', () => {
  test('derives a clean slug from an OS hostname, stripping local domain suffixes', () => {
    expect(deriveDeviceName('Elis-MacBook-Pro.local')).toBe('elis-macbook-pro');
    expect(deriveDeviceName('studio-mac-mini.lan')).toBe('studio-mac-mini');
    expect(deriveDeviceName('Workstation_01.home')).toBe('workstation-01');
  });

  test('falls back to a readable generated name for generic or container hostnames', () => {
    const fromLocalhost = deriveDeviceName('localhost', '550e8400-e29b-41d4-a716-446655440000');
    expect(fromLocalhost).toMatch(/^[a-z]+-[a-z]+-550e$/);

    const fromContainer = deriveDeviceName('a1b2c3d4e5f6', '99887766-e29b-41d4-a716-446655440000');
    expect(fromContainer).toMatch(/^[a-z]+-[a-z]+-9988$/);

    const fromEmpty = deriveDeviceName('', '1234abcd');
    expect(fromEmpty).toMatch(/^[a-z]+-[a-z]+-1234$/);
  });

  test('generateRandomDeviceName is deterministic for a given seed', () => {
    const first = generateRandomDeviceName('device-seed-abc123');
    const second = generateRandomDeviceName('device-seed-abc123');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-z]+-[a-z]+-devi$/);
  });

  test('AppSettingsSchema populates device and checkpoints defaults', () => {
    const settings = AppSettingsSchema.parse({});
    expect(settings.device.id.length).toBeGreaterThan(0);
    expect(settings.device.name.length).toBeGreaterThan(0);
    expect(settings.checkpoints.enabled).toBe(true);
    expect(settings.checkpoints.supabase.table_prefix).toBe('solenoid_');
  });

  test('DeviceConfigSchema validates non-empty device names', () => {
    expect(DeviceConfigSchema.safeParse({ id: 'dev-1', name: '   ' }).success).toBe(false);
    expect(DeviceConfigSchema.parse({ id: 'dev-1', name: '  my-laptop  ' })).toEqual({
      id: 'dev-1',
      name: 'my-laptop',
    });
  });
});
