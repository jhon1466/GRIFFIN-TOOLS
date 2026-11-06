import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  ArrowDownToLine, Copy, FolderOpen, Gamepad2, LoaderCircle, Play, RefreshCw, Server, Square, Wrench,
} from 'lucide-solid';
import type { Language } from '../i18n';

type Settings = { serverVersion?: string; patcherVersion?: string; gameDir?: string; autoUpdate: boolean; publicHost: string };
type Status = {
  appVersion: string; settings: Settings; installed: boolean; serverRunning: boolean; postgresRunning: boolean;
  busyPorts: number[]; dataDir: string; patcherInGame: boolean;
};
type Progress = { stage: string; pct: number; message: string };

const text = {
  es: {
    title: 'Servidor local', hint: 'Instala, inicia y mantiene actualizado Griffin sin compilar nada.',
    running: 'Encendido', stopped: 'Apagado', notInstalled: 'No instalado', install: 'Instalar todo', update: 'Buscar actualizaciones',
    start: 'Iniciar servidor', stop: 'Detener', version: 'Versión del servidor', app: 'Versión de GM Tools', db: 'Base de datos',
    auto: 'Instalar actualizaciones automáticamente', host: 'Dirección para los jugadores',
    hostHint: '127.0.0.1 = solo esta PC. Para jugar en red pon la IP de esta PC.', save: 'Guardar',
    game: 'Juego', gameDir: 'Carpeta de GF2 (donde está GF2_Exilium.exe)', patch: 'Instalar parche', play: 'Jugar',
    patched: 'Parche instalado', unpatched: 'Parche no instalado', log: 'Registro del servidor', folder: 'Abrir carpeta',
    diag: 'Copiar diagnóstico', copied: 'Diagnóstico copiado', ports: 'Puertos ocupados por otro programa:', saved: 'Guardado',
  },
  en: {
    title: 'Local server', hint: 'Installs, starts and keeps Griffin up to date without building anything.',
    running: 'Running', stopped: 'Stopped', notInstalled: 'Not installed', install: 'Install everything', update: 'Check for updates',
    start: 'Start server', stop: 'Stop', version: 'Server version', app: 'GM Tools version', db: 'Database',
    auto: 'Install updates automatically', host: 'Address for players',
    hostHint: '127.0.0.1 = this PC only. For LAN play use this PC\'s IP.', save: 'Save',
    game: 'Game', gameDir: 'GF2 folder (where GF2_Exilium.exe is)', patch: 'Install patch', play: 'Play',
    patched: 'Patch installed', unpatched: 'Patch not installed', log: 'Server log', folder: 'Open folder',
    diag: 'Copy diagnostics', copied: 'Diagnostics copied', ports: 'Ports used by another program:', saved: 'Saved',
  },
  zh: {
    title: '本地服务器', hint: '无需编译即可安装、启动并自动更新 Griffin。',
    running: '运行中', stopped: '已停止', notInstalled: '未安装', install: '一键安装', update: '检查更新',
    start: '启动服务器', stop: '停止', version: '服务器版本', app: 'GM Tools 版本', db: '数据库',
    auto: '自动安装更新', host: '玩家连接地址', hostHint: '127.0.0.1 = 仅本机。局域网游玩请填写本机 IP。', save: '保存',
    game: '游戏', gameDir: 'GF2 目录（包含 GF2_Exilium.exe）', patch: '安装补丁', play: '开始游戏',
    patched: '补丁已安装', unpatched: '补丁未安装', log: '服务器日志', folder: '打开目录',
    diag: '复制诊断信息', copied: '已复制', ports: '端口被其他程序占用：', saved: '已保存',
  },
};

export default function ServerPanel(props: { language: Language; onStarted: () => void; notify: (m: string, error?: boolean) => void }) {
  const t = (k: keyof typeof text.es) => text[props.language][k];
  const [status, setStatus] = createSignal<Status>();
  const [prog, setProg] = createSignal<Progress>();
  const [working, setWorking] = createSignal(false);
  const [log, setLog] = createSignal('');
  const [host, setHost] = createSignal('127.0.0.1');
  const [gameDir, setGameDir] = createSignal('');
  let timer: number | undefined;
  let unlisten: (() => void) | undefined;

  async function refresh() {
    const s = await invoke<Status>('manager_status');
    setStatus(s);
    if (!host() || host() === '127.0.0.1') setHost(s.settings.publicHost);
    if (!gameDir() && s.settings.gameDir) setGameDir(s.settings.gameDir);
    setLog(await invoke<string>('manager_log_tail', { lines: 120 }));
  }

  async function run(action: () => Promise<unknown>, ok?: string) {
    setWorking(true);
    try {
      const r = await action();
      if (typeof r === 'string') props.notify(r);
      else if (ok) props.notify(ok);
    } catch (e) { props.notify(String(e), true); }
    finally { setWorking(false); void refresh(); }
  }

  const start = () => run(async () => {
    await invoke('manager_start');
    // Give Griffin a moment to open its ports, then connect GM Tools with the generated token.
    window.setTimeout(props.onStarted, 4000);
  }, t('running'));

  function copyDiag() {
    const s = status();
    const lines = [
      `GM Tools ${s?.appVersion} · server ${s?.settings.serverVersion ?? '-'} · patcher ${s?.settings.patcherVersion ?? '-'}`,
      `running=${s?.serverRunning} postgres=${s?.postgresRunning} busyPorts=${s?.busyPorts.join(',') || '-'}`,
      `host=${s?.settings.publicHost} gameDir=${s?.settings.gameDir ?? '-'} patched=${s?.patcherInGame}`,
      `data=${s?.dataDir}`, `last=${prog()?.message ?? '-'}`, '', log().split('\n').slice(-60).join('\n'),
    ];
    void navigator.clipboard.writeText(lines.join('\n')).then(() => props.notify(t('copied')));
  }

  onMount(() => {
    void refresh();
    timer = window.setInterval(() => void refresh(), 3000);
    void listen<Progress>('manager-progress', (ev) => {
      setProg(ev.payload);
      if (ev.payload.stage === 'done' || ev.payload.stage === 'error') void refresh();
    }).then((u) => (unlisten = u));
  });
  onCleanup(() => { if (timer) window.clearInterval(timer); unlisten?.(); });

  const badge = () => (status()?.serverRunning ? t('running') : status()?.installed ? t('stopped') : t('notInstalled'));

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-end justify-between">
        <div><h2 class="section-title">{t('title')}</h2><p class="section-subtitle">{t('hint')}</p></div>
        <span class={`tiny-chip ${status()?.serverRunning ? 'text-aqua-300' : ''}`}><Server size={12}/> {badge()}</span>
      </div>

      <section class="surface-card p-5">
        <div class="grid grid-cols-4 gap-4 text-[12px]">
          <div><div class="card-caption">{t('version')}</div><div class="mt-1 text-[15px] font-bold">{status()?.settings.serverVersion ?? '—'}</div></div>
          <div><div class="card-caption">{t('app')}</div><div class="mt-1 text-[15px] font-bold">{status()?.appVersion ?? '—'}</div></div>
          <div><div class="card-caption">{t('db')}</div><div class="mt-1 text-[15px] font-bold">{status()?.postgresRunning ? t('running') : t('stopped')}</div></div>
          <div class="flex items-start justify-end gap-2">
            <Show when={status()?.serverRunning} fallback={
              <button class="primary-button" disabled={working()} onClick={() => void start()}>
                <Play size={14}/> {status()?.installed ? t('start') : t('install')}
              </button>}>
              <button class="danger-button" disabled={working()} onClick={() => void run(() => invoke('manager_stop'), t('stopped'))}><Square size={14}/> {t('stop')}</button>
            </Show>
            <button class="quiet-button" disabled={working()} onClick={() => void run(() => invoke<string>('manager_update'))}><RefreshCw size={14}/> {t('update')}</button>
          </div>
        </div>
        <Show when={prog()}>
          <div class="mt-4">
            <div class="flex items-center gap-2 text-[12px]"><Show when={working() || (prog()!.stage !== 'done' && prog()!.stage !== 'error')}><LoaderCircle size={13} class="animate-spin"/></Show>
              <span class={prog()!.stage === 'error' ? 'text-red-300' : 'text-ice-300'}>{prog()!.message}</span></div>
            <div class="mt-2 h-1.5 overflow-hidden rounded bg-white/[0.06]"><div class="h-full bg-aqua-400 transition-all" style={{ width: `${Math.min(100, prog()!.pct)}%` }}/></div>
          </div>
        </Show>
        <Show when={(status()?.busyPorts.length ?? 0) > 0}>
          <div class="mt-3 text-[12px] text-amber-300">{t('ports')} {status()!.busyPorts.join(', ')}</div>
        </Show>
      </section>

      <div class="grid grid-cols-2 gap-4">
        <section class="surface-card p-5">
          <h3 class="card-title flex items-center gap-2"><Wrench size={15}/> {t('host')}</h3>
          <p class="card-caption mb-3">{t('hostHint')}</p>
          <div class="flex gap-2">
            <input class="input-field flex-1" value={host()} onInput={(e) => setHost(e.currentTarget.value)}/>
            <button class="secondary-button" onClick={() => void run(() => invoke('manager_set_settings', { autoUpdate: status()?.settings.autoUpdate ?? true, publicHost: host() }), t('saved'))}>{t('save')}</button>
          </div>
          <label class="mt-4 flex items-center gap-2 text-[12px]">
            <input type="checkbox" checked={status()?.settings.autoUpdate ?? true}
              onChange={(e) => void run(() => invoke('manager_set_settings', { autoUpdate: e.currentTarget.checked, publicHost: host() }), t('saved'))}/>
            {t('auto')}
          </label>
        </section>

        <section class="surface-card p-5">
          <h3 class="card-title flex items-center gap-2"><Gamepad2 size={15}/> {t('game')}
            <span class="tiny-chip ml-auto">{status()?.patcherInGame ? t('patched') : t('unpatched')}</span></h3>
          <p class="card-caption mb-3">{t('gameDir')}</p>
          <div class="flex gap-2">
            <input class="input-field flex-1" placeholder="C:\Program Files\GF2Exilium\GF2 Game" value={gameDir()} onInput={(e) => setGameDir(e.currentTarget.value)}/>
            <button class="secondary-button" disabled={working()} onClick={() => void run(() => invoke('manager_set_game_dir', { gameDir: gameDir() }), t('patched'))}><ArrowDownToLine size={14}/> {t('patch')}</button>
          </div>
          <button class="primary-button mt-4" disabled={!status()?.patcherInGame || !status()?.serverRunning} onClick={() => void run(() => invoke('manager_play'))}><Play size={14}/> {t('play')}</button>
        </section>
      </div>

      <section class="surface-card p-5">
        <div class="mb-3 flex items-center justify-between">
          <h3 class="card-title">{t('log')}</h3>
          <div class="flex gap-2">
            <button class="quiet-button" onClick={() => void invoke('manager_open_folder')}><FolderOpen size={14}/> {t('folder')}</button>
            <button class="quiet-button" onClick={copyDiag}><Copy size={14}/> {t('diag')}</button>
          </div>
        </div>
        <pre class="max-h-[260px] overflow-auto rounded-lg bg-black/30 p-3 text-[11px] leading-relaxed text-ice-300">{log() || '—'}</pre>
      </section>
    </div>
  );
}
