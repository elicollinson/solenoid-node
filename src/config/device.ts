/**
 * Device Identity
 *
 * Each machine running Solenoid gets a stable UUID (`device.id`) and a
 * human-readable name (`device.name`). The ID never changes when the person
 * renames the device with `/device-name`, so historical sessions and
 * checkpoints from this machine can be updated in place and distinguished
 * from runs that happened on another device.
 */
import { hostname as osHostname } from 'node:os';

const ADJECTIVES = [
  'amber',
  'arctic',
  'cobalt',
  'copper',
  'crimson',
  'emerald',
  'golden',
  'indigo',
  'obsidian',
  'silver',
  'solar',
  'velvet',
] as const;

const NOUNS = [
  'anchor',
  'beacon',
  'comet',
  'dynamo',
  'falcon',
  'harbor',
  'horizon',
  'lantern',
  'meadow',
  'pulsar',
  'relay',
  'solenoid',
] as const;

const GENERIC_HOSTNAMES = new Set([
  '',
  'localhost',
  'localhost.localdomain',
  'darwin',
  'linux',
  'ubuntu',
  'debian',
  'fedora',
  'archlinux',
  'windows',
]);

const LOCAL_DOMAIN_SUFFIXES = [
  '.local',
  '.lan',
  '.home',
  '.internal',
  '.localdomain',
  '.corp',
  '.attlocal.net',
] as const;

/**
 * Turn an OS hostname into a clean slug, or generate a readable fallback when
 * the hostname is generic or looks like a container ID.
 */
export function deriveDeviceName(rawHostname: string = safeHostname(), seed?: string): string {
  let stripped = rawHostname.trim().toLowerCase();
  for (const suffix of LOCAL_DOMAIN_SUFFIXES) {
    if (stripped.endsWith(suffix)) {
      stripped = stripped.slice(0, -suffix.length);
      break;
    }
  }

  const joined = stripped
    .slice(0, 128)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-')
    .slice(0, 48);
  const slug = joined.endsWith('-') ? joined.slice(0, -1) : joined;

  // Container IDs (12 or 64 hex chars) and generic hostnames get a friendly generated name.
  const isHexContainerId = /^[0-9a-f]{12}$|^[0-9a-f]{64}$/.test(slug);
  if (slug.length >= 2 && !GENERIC_HOSTNAMES.has(slug) && !isHexContainerId) {
    return slug;
  }

  return generateRandomDeviceName(seed);
}

/**
 * Generate a readable `<adjective>-<noun>-<shorthex>` device name.
 * When `seed` is given (such as a device UUID), the name is deterministic.
 */
export function generateRandomDeviceName(seed: string = crypto.randomUUID()): string {
  const clean = seed.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || '00000000';
  let hash = 2166136261;
  for (let i = 0; i < clean.length; i++) {
    hash ^= clean.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const unsigned = hash >>> 0;
  const adj = ADJECTIVES[unsigned % ADJECTIVES.length]!;
  const noun = NOUNS[Math.floor(unsigned / ADJECTIVES.length) % NOUNS.length]!;
  const suffix = clean.slice(0, 4).padEnd(4, '0');
  return `${adj}-${noun}-${suffix}`;
}

function safeHostname(): string {
  try {
    return osHostname();
  } catch {
    return '';
  }
}
