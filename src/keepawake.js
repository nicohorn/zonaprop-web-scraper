// Evita que Windows suspenda la PC mientras hay una corrida en curso (si se duerme a las dos
// horas, la corrida "de toda la noche" no sirvió). No impide que se apague la pantalla.
//
// SetThreadExecutionState vale mientras viva el hilo que lo pidió, así que se deja un
// PowerShell oculto con el pedido hecho; se va solo si este proceso muere.

import { spawn } from 'node:child_process';

const SCRIPT = `
$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$k = Add-Type -MemberDefinition $sig -Name Power -Namespace ZonapropScraper -PassThru
[void]$k::SetThreadExecutionState([uint32]2147483649) # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }
`;

/** @returns {{ stop: () => void }} */
export function keepAwake() {
  if (process.platform !== 'win32') return { stop() {} };
  let child = null;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); // sin PowerShell no hay keep-awake; no es motivo para frenar
  } catch { /* idem */ }
  return { stop() { try { child?.kill(); } catch { /* ya terminó */ } } };
}
