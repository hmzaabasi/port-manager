const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveScript(filename) {
  const packaged = path.join(process.resourcesPath || '', 'scripts', filename);
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, filename);
}

const CRITICAL_NAMES = new Set([
  'system',
  'system idle process',
  'idle',
  'registry',
  'secure system',
  'memory compression',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'services.exe',
  'lsass.exe',
  'lsaiso.exe',
  'winlogon.exe',
]);

const SYSTEM_NAMES = new Set([
  'svchost.exe',
  'fontdrvhost.exe',
  'dwm.exe',
  'sihost.exe',
  'taskhostw.exe',
  'runtimebroker.exe',
  'searchhost.exe',
  'searchindexer.exe',
  'startmenuexperiencehost.exe',
  'shellexperiencehost.exe',
  'explorer.exe',
  'textinputhost.exe',
  'securityhealthservice.exe',
  'securityhealthsystray.exe',
  'msmpeng.exe',
  'nissrv.exe',
  'spoolsv.exe',
  'dashost.exe',
  'ctfmon.exe',
  'dllhost.exe',
  'conhost.exe',
  'wudfhost.exe',
  'audiodg.exe',
  'wmiprvse.exe',
  'aggregatorhost.exe',
]);

const commandCache = new Map();
const commandPending = new Set();
let commandQueue = Promise.resolve();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const stdout = [];
    const stderr = [];

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function decodeOutput(buffer) {
  if (!buffer.length) return '';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0) {
    return buffer.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function cleanPowerShellError(text) {
  const stripped = text.replace(/^\uFEFF/, '').trim();
  const parts = [...stripped.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((match) =>
    match[1]
      .replace(/_x000D__x000A_/g, ' ')
      .replace(/_x000D_/g, '')
      .replace(/_x000A_/g, ' ')
      .trim()
  );
  if (parts.length) return parts.filter(Boolean).join(' ');
  return stripped;
}

function displayName(pid, name) {
  if (name && name.trim()) return name.trim();
  if (pid === 0) return 'System Idle Process';
  if (pid === 4) return 'System';
  return 'Unknown';
}

function isDevProcess(name) {
  return /^(node|python|pythonw|java|javaw|dotnet|ruby|php|php-cgi|httpd|nginx|perl|bun|deno)\.exe$/i.test(name);
}

function classify(pid, name) {
  const key = name.toLowerCase();
  if (pid <= 4 || CRITICAL_NAMES.has(key)) return 'critical';
  if (SYSTEM_NAMES.has(key)) return 'system';
  return 'app';
}

function scopeOf(addresses) {
  const loopback = new Set(['127.0.0.1', '::1']);
  const anyAddress = new Set(['0.0.0.0', '::', '*']);
  if (addresses.length && addresses.every((address) => loopback.has(address))) return 'local';
  if (addresses.some((address) => anyAddress.has(address))) return 'all';
  return 'network';
}

function groupListeners(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const key = `${row.pid}:${row.port}`;
    let item = grouped.get(key);
    if (!item) {
      const name = displayName(row.pid, row.name);
      item = {
        pid: row.pid,
        port: row.port,
        name,
        path: row.path || '',
        command: (row.command || '').trim(),
        addresses: [],
        kind: classify(row.pid, name),
      };
      grouped.set(key, item);
    }
    if (row.address && !item.addresses.includes(row.address)) item.addresses.push(row.address);
    if (!item.path && row.path) item.path = row.path;
    if (!item.command && row.command) item.command = row.command.trim();
  }

  return [...grouped.values()]
    .map((item) => ({ ...item, scope: scopeOf(item.addresses) }))
    .sort((a, b) => {
      const devDelta = Number(!isDevProcess(a.name)) - Number(!isDevProcess(b.name));
      return devDelta || a.port - b.port || a.name.localeCompare(b.name) || a.pid - b.pid;
    });
}

function decorate(listeners) {
  return listeners.map((item) => {
    const extra = commandCache.get(item.pid);
    if (!extra) return item;
    return {
      ...item,
      path: extra.path || item.path,
      command: extra.command || item.command,
    };
  });
}

function parseNetstat(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\[[^\]]+\]|[\d.]+):(\d+)\s+\S+:0\s+\S+\s+(\d+)\s*$/i);
    if (!match) continue;
    let address = match[1];
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
    rows.push({
      address,
      port: Number(match[2]),
      pid: Number(match[3]),
      name: '',
      path: '',
      command: '',
    });
  }
  return rows;
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseTasklist(text) {
  const names = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const pid = Number(fields[1]);
    if (fields[0] && Number.isInteger(pid)) names.set(pid, fields[0]);
  }
  return names;
}

async function readSockets() {
  const [netstat, tasklist] = await Promise.all([
    run('netstat.exe', ['-ano', '-p', 'tcp']),
    run('tasklist.exe', ['/FO', 'CSV', '/NH']),
  ]);

  if (netstat.code !== 0) {
    throw new Error(decodeOutput(netstat.stderr).trim() || 'netstat failed.');
  }

  const text = decodeOutput(netstat.stdout);
  const rows = parseNetstat(text);
  if (rows.length === 0 && /^\s*TCP\s/m.test(text)) {
    throw new Error('Could not parse listening ports.');
  }

  const names = tasklist.code === 0 ? parseTasklist(decodeOutput(tasklist.stdout)) : new Map();
  for (const row of rows) row.name = names.get(row.pid) || '';
  return rows;
}

async function listWithPowerShell() {
  const scriptFile = resolveScript('list-ports.ps1');
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptFile,
  ]);
  const stdout = decodeOutput(result.stdout).trim();
  if (result.code !== 0) {
    throw new Error(cleanPowerShellError(decodeOutput(result.stderr)) || `Port lookup failed (exit ${result.code}).`);
  }

  const parsed = stdout ? JSON.parse(stdout) : [];
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => Number.isInteger(row.port) && Number.isInteger(row.pid))
    .map((row) => ({
      address: String(row.address || ''),
      port: row.port,
      pid: row.pid,
      name: String(row.name || ''),
      path: String(row.path || ''),
      command: String(row.command || ''),
    }));
}

async function listListeners() {
  let rows;
  try {
    rows = await readSockets();
  } catch (error) {
    try {
      rows = await listWithPowerShell();
    } catch (fallbackError) {
      const primary = error instanceof Error ? error.message : String(error);
      const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${primary} Fallback also failed: ${detail}`);
    }
  }

  const livePids = new Set(rows.map((row) => row.pid));
  for (const pid of commandCache.keys()) {
    if (!livePids.has(pid)) commandCache.delete(pid);
  }

  return decorate(groupListeners(rows));
}

async function fetchCommands(pids) {
  const ids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 4))];
  if (!ids.length) return [];

  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resolveScript('list-commands.ps1'),
    '-Ids',
    ids.join(','),
  ]);
  const stdout = decodeOutput(result.stdout).trim();
  if (result.code !== 0) {
    throw new Error(cleanPowerShellError(decodeOutput(result.stderr)) || 'Could not read process commands.');
  }
  if (!stdout) return [];

  const parsed = JSON.parse(stdout);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => Number.isInteger(row.pid))
    .map((row) => ({
      pid: row.pid,
      path: String(row.path || ''),
      command: String(row.command || '').trim(),
    }));
}

function requestCommands(listeners, onUpdate) {
  const needed = [...new Set(
    listeners
      .filter((item) => item.kind === 'app' && !commandCache.has(item.pid) && !commandPending.has(item.pid))
      .map((item) => item.pid)
  )];
  if (!needed.length) return;

  for (const pid of needed) commandPending.add(pid);
  commandQueue = commandQueue
    .then(() => fetchCommands(needed))
    .then((details) => {
      const byPid = new Map(details.map((detail) => [detail.pid, detail]));
      const updates = needed.map((pid) => {
        const found = byPid.get(pid) || { pid, path: '', command: '' };
        commandCache.set(pid, found);
        return found;
      });
      onUpdate(updates.filter((item) => item.command || item.path));
    })
    .catch(() => {})
    .finally(() => {
      for (const pid of needed) commandPending.delete(pid);
    });
}

function assertStoppablePid(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 4 || value > 2147483647) {
    throw new Error('That process cannot be stopped from Port Manager.');
  }
  return value;
}

async function killProcess(pid) {
  const value = assertStoppablePid(pid);
  const result = await run('taskkill.exe', ['/PID', String(value), '/T', '/F']);
  const stderr = decodeOutput(result.stderr).trim();
  const stdout = decodeOutput(result.stdout).trim();

  if (result.code === 0 || /not found/i.test(`${stderr}\n${stdout}`)) {
    commandCache.delete(value);
    return { message: stdout || 'Process stopped.' };
  }
  throw new Error(stderr || stdout || `Could not stop process ${value}.`);
}

module.exports = {
  listListeners,
  requestCommands,
  killProcess,
};
