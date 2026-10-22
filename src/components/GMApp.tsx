import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import {
  Activity, ArrowDownToLine, ArrowRight, Boxes, Check, CircleHelp, Command, Database,
  Gauge, Gift, LayoutDashboard, LoaderCircle, LogOut, Package, Plus, RefreshCw,
  Search, Server, ShieldCheck, TerminalSquare, Trash2, Users, Wifi, X, Zap,
} from 'lucide-solid';
import { copy, type Language } from '../i18n';
import gmCatalogUrl from '../data/gm-catalog.json?url';

type Tab = 'overview' | 'accounts' | 'operations' | 'commands';
type Account = { uid: number; email: string; isGuest: boolean; timeLastLogin: string; selected?: boolean };
type ServerStatus = { uptimeSeconds: number; database: string; accounts: number | null; online: number };
type GameCommand = { name: string; description: string; usage: string };
type CatalogEntry = { id: number; gunId?: number; weaponId?: number; default?: boolean; name: string; displayName?: string; names?: Partial<Record<'en' | 'es', string>>; aliases?: string[]; image?: string };

const routeDefs: { id: Tab; key: keyof typeof copy.es; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', key: 'navOverview', icon: LayoutDashboard },
  { id: 'accounts', key: 'navAccounts', icon: Users },
  { id: 'operations', key: 'navOperations', icon: Boxes },
  { id: 'commands', key: 'navCommands', icon: TerminalSquare },
];
type LocalCatalog = { characters: CatalogEntry[]; weapons: CatalogEntry[]; items: CatalogEntry[]; costumes: CatalogEntry[]; weaponSkins: CatalogEntry[] };
const emptyCatalog: LocalCatalog = { characters: [], weapons: [], items: [], costumes: [], weaponSkins: [] };

export default function GMApp() {
  const [language, setLanguage] = createSignal<Language>('es');
  const t = (key: keyof typeof copy.es) => copy[language()][key];
  const [tab, setTab] = createSignal<Tab>('overview');
  const [address, setAddress] = createSignal('https://127.0.0.1');
  const [token, setToken] = createSignal('');
  const [connected, setConnected] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [status, setStatus] = createSignal<ServerStatus>();
  const [localCatalog, setLocalCatalog] = createSignal<LocalCatalog>(emptyCatalog);
  const [accounts, setAccounts] = createSignal<Account[]>([]);
  const [accountQuery, setAccountQuery] = createSignal('');
  const [accountDetail, setAccountDetail] = createSignal<Record<string, unknown>>();
  const [commands, setCommands] = createSignal<GameCommand[]>([]);
  const [commandText, setCommandText] = createSignal('');
  const [commandResult, setCommandResult] = createSignal('');
  const [notice, setNotice] = createSignal<{ text: string; error?: boolean }>();
  const [lastAction, setLastAction] = createSignal('');
  const [itemUid, setItemUid] = createSignal('');
  const [itemId, setItemId] = createSignal('');
  const [itemSearch, setItemSearch] = createSignal('');
  const [itemCount, setItemCount] = createSignal('1');
  const [gunUid, setGunUid] = createSignal('');
  const [gunId, setGunId] = createSignal('');
  const [gunSearch, setGunSearch] = createSignal('');
  const [gunLevel, setGunLevel] = createSignal('60');
  const [weaponUid, setWeaponUid] = createSignal('');
  const [weaponId, setWeaponId] = createSignal('');
  const [weaponSearch, setWeaponSearch] = createSignal('');
  const [weaponCount, setWeaponCount] = createSignal('1');
  const [chosenCostumes, setChosenCostumes] = createSignal<number[]>([]);
  const [chosenSkins, setChosenSkins] = createSignal<number[]>([]);
  const [cleanUid, setCleanUid] = createSignal('');
  const [cleanType, setCleanType] = createSignal('items');
  let poller: number | undefined;
  let noticeTimer: number | undefined;

  const filteredCharacters = createMemo(() => {
    const query = normalizeCatalogQuery(gunSearch());
    return localCatalog().characters.filter((entry) => !query || normalizeCatalogQuery(catalogSearchText(entry)).includes(query));
  });
  const filteredWeapons = createMemo(() => {
    const query = normalizeCatalogQuery(weaponSearch());
    return localCatalog().weapons.filter((entry) => !query || normalizeCatalogQuery(catalogSearchText(entry)).includes(query));
  });
  const filteredItems = createMemo(() => {
    const query = normalizeCatalogQuery(itemSearch());
    const found = localCatalog().items.filter((entry) => !query || normalizeCatalogQuery(catalogSearchText(entry)).includes(query));
    // Items with an icon (the real, obtainable ones) first; the table also holds many retired rows.
    return [...found.filter((entry) => entry.image), ...found.filter((entry) => !entry.image)].slice(0, 600);
  });
  const costumesOfSelected = createMemo(() => localCatalog().costumes.filter((entry) => entry.gunId === Number(gunId())));
  const skinsOfSelected = createMemo(() => localCatalog().weaponSkins.filter((entry) => entry.weaponId === Number(weaponId())));
  const toggleIn = (list: () => number[], set: (value: number[]) => void, id: number) => set(list().includes(id) ? list().filter((x) => x !== id) : [...list(), id]);
  const selectedItem = createMemo(() => localCatalog().items.find((entry) => entry.id === Number(itemId())));
  const selectedCharacter = createMemo(() => localCatalog().characters.find((entry) => entry.id === Number(gunId())));
  const selectedWeapon = createMemo(() => localCatalog().weapons.find((entry) => entry.id === Number(weaponId())));

  async function request<T = unknown>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return await invoke<T>('gm_request', { baseUrl: address().trim(), method, path, token: token(), body: body ?? null });
  }

  function notify(text: string, error = false) {
    setNotice({ text, error });
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => setNotice(undefined), 4600);
  }

  async function refreshStatus() {
    const next = await request<ServerStatus>('GET', 'status');
    setStatus(next);
    setConnected(true);
  }

  async function connect() {
    if (token().trim().length < 24) return notify(t('tokenShort'), true);
    setToken(token().trim());
    setBusy(true);
    try {
      const [nextStatus, commandList] = await Promise.all([
        request<ServerStatus>('GET', 'status'),
        request<GameCommand[]>('GET', 'commands'),
      ]);
      setStatus(nextStatus);
      setCommands(commandList);
      setConnected(true);
      setLastAction(t('connectionVerified'));
      try {
        await invoke('save_gm_token', { token: token().trim() });
        notify(t('connectedMessage'));
      } catch {
        notify(t('tokenSaveFailed'), true);
      }
      if (poller) window.clearInterval(poller);
      poller = window.setInterval(() => void refreshStatus().catch((e: Error) => {
        setConnected(false); setLastAction(e.message);
      }), 5000);
    } catch (e) { setConnected(false); notify((e as Error).message, true); }
    finally { setBusy(false); }
  }

  function disconnect() {
    if (poller) window.clearInterval(poller);
    setConnected(false); setStatus(undefined);
    setAccounts([]); setAccountDetail(undefined); setCommands([]); setLastAction(t('sessionClosed'));
  }

  async function searchAccounts() {
    setBusy(true);
    try {
      const query = encodeURIComponent(accountQuery().trim());
      const data = await request<Account[]>('GET', `accounts?q=${query}`);
      setAccounts(data); setAccountDetail(undefined);
      setLastAction(`${t('search')} · ${data.length} ${t('results').toLocaleLowerCase()}`);
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  }

  async function openAccount(account: Account) {
    setAccounts((rows) => rows.map((row) => ({ ...row, selected: row.uid === account.uid })));
    try {
      const detail = await request<Record<string, unknown>>('GET', `accounts/${account.uid}`);
      setAccountDetail(detail); setLastAction(`${t('account')} ${account.uid}`);
    } catch (e) { notify((e as Error).message, true); }
  }

  async function deleteSelectedAccount() {
    const account = accountDetail()?.account as Record<string, unknown> | undefined;
    const uid = Number(account?.uid);
    if (!Number.isInteger(uid) || uid <= 0 || accountDetail()?.online) return;
    const confirmation = t('deleteAccountConfirm').replace('{uid}', String(uid));
    if (window.prompt(confirmation) !== String(uid)) return;
    setBusy(true);
    try {
      await request('DELETE', `accounts/${uid}`);
      setAccounts((rows) => rows.filter((row) => row.uid !== uid));
      setAccountDetail(undefined);
      setLastAction(`${t('deleteAccount')} · ${uid}`);
      notify(t('accountDeleted'));
      if (status()) await refreshStatus();
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  }

  async function runAction(path: string, body: unknown, label: string) {
    setBusy(true);
    try {
      const result = await request<Record<string, unknown>>('POST', path, body);
      setLastAction(`${label} · ${new Date().toLocaleTimeString()}`);
      notify(`${label}. ${JSON.stringify(result)}`);
      if (accountDetail()) {
        const uid = (accountDetail()!.account as Record<string, unknown> | undefined)?.uid;
        if (uid) await openAccount({ uid: Number(uid), email: '', isGuest: false, timeLastLogin: '' });
      }
      if (status()) await refreshStatus();
    } catch (e) { notify((e as Error).message, true); }
    finally { setBusy(false); }
  }

  async function grantItem(event: SubmitEvent) {
    event.preventDefault();
    const uid = Number(itemUid()), id = Number(itemId()), count = Number(itemCount());
    if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(id) || !localCatalog().items.some((entry) => entry.id === id) || !Number.isInteger(count) || count < 1 || count > 1_000_000) return notify(t('itemValidation'), true);
    await runAction(`accounts/${uid}/items`, { itemId: id, count }, t('itemDone'));
  }

  async function grantGun(event: SubmitEvent) {
    event.preventDefault();
    const uid = Number(gunUid()), id = Number(gunId()), level = Number(gunLevel());
    if (!Number.isInteger(uid) || uid <= 0 || !localCatalog().characters.some((entry) => entry.id === id) || !Number.isInteger(level) || level < 1 || level > 60) return notify(t('characterValidation'), true);
    await runAction(`accounts/${uid}/characters`, { gunId: id, level }, t('characterDone'));
    for (const costumeId of chosenCostumes()) await runAction(`accounts/${uid}/costumes`, { costumeId }, t('costumeDone'));
  }

  async function grantWeapon(event: SubmitEvent) {
    event.preventDefault();
    const uid = Number(weaponUid()), id = Number(weaponId()), count = Number(weaponCount());
    if (!Number.isInteger(uid) || uid <= 0 || !localCatalog().weapons.some((entry) => entry.id === id) || !Number.isInteger(count) || count < 1 || count > 50) return notify(t('weaponValidation'), true);
    await runAction(`accounts/${uid}/weapons`, { weaponId: id, count }, t('weaponDone'));
    for (const skinId of chosenSkins()) await runAction(`accounts/${uid}/weapon-skins`, { skinId }, t('weaponSkinDone'));
  }

  async function cleanInventory(event: SubmitEvent) {
    event.preventDefault();
    const uid = Number(cleanUid());
    if (!Number.isInteger(uid) || uid <= 0) return notify(t('uidInvalid'), true);
    const confirmation = t('resetConfirm').replace('{uid}', String(uid));
    if (window.prompt(confirmation) !== String(uid)) return;
    await runAction(`accounts/${uid}/clean`, { confirmUid: uid, type: cleanType() }, t('cleanDone'));
  }

  async function executeCommand(event: SubmitEvent) {
    event.preventDefault();
    if (!commandText().trim()) return;
    setBusy(true);
    try {
      const result = await request('POST', 'commands', { command: commandText().trim() });
      setCommandResult(JSON.stringify(result, null, 2));
      setLastAction(`${t('execute')} · ${new Date().toLocaleTimeString()}`);
    } catch (e) { setCommandResult((e as Error).message); }
    finally { setBusy(false); }
  }

  onMount(() => {
    void invoke<string | null>('load_saved_gm_token').then((saved) => {
      if (saved) setToken(saved);
    }).catch(() => undefined);
    const savedLanguage = localStorage.getItem('griffin-gm-language');
    if (savedLanguage === 'es' || savedLanguage === 'en' || savedLanguage === 'zh') setLanguage(savedLanguage);
    void fetch(gmCatalogUrl).then((response) => {
      if (!response.ok) throw new Error(`Catalog file returned ${response.status}`);
      return response.json() as Promise<LocalCatalog>;
    }).then(setLocalCatalog).catch(() => notify(t('catalogLoadError'), true));
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle('Griffin GM Tools'));
  });
  onCleanup(() => { if (poller) window.clearInterval(poller); if (noticeTimer) window.clearTimeout(noticeTimer); });

  return (
    <div class="app-shell flex h-screen min-h-[720px] w-screen min-w-[1080px] overflow-hidden bg-ink-950 text-ice-100">
      <aside class="sidebar relative flex w-[248px] shrink-0 flex-col border-r border-white/[0.07] bg-[#111416] px-4 py-5">
        <div class="brand flex items-center gap-3 px-2 pb-8">
          <div class="brand-mark grid size-12 place-items-center rounded-xl border border-white/10 bg-[#252a2e] p-1 shadow-[0_0_28px_#f2762b25]"><img src="/griffin-logo.png" alt="Elmo CE" class="h-full w-full object-contain" /></div>
          <div><div class="text-[15px] font-black tracking-[.22em]">GRIFFIN</div><div class="mt-0.5 text-[10px] font-semibold tracking-[.28em] text-aqua-300">GM CONTROL</div></div>
        </div>
        <div class="mb-2 flex items-center justify-between px-3 text-[10px] font-bold uppercase tracking-[.2em] text-ice-500"><span>{t('workspace')}</span><select aria-label={t('language')} class="language-select" value={language()} onChange={(e) => { const next = e.currentTarget.value as Language; setLanguage(next); localStorage.setItem('griffin-gm-language', next); }}><option value="es">ES</option><option value="en">EN</option><option value="zh">中文</option></select></div>
        <nav class="flex flex-col gap-1"><For each={routeDefs}>{(route) => { const Icon = route.icon; return <button onClick={() => setTab(route.id)} class={`nav-item group flex h-11 items-center gap-3 rounded-lg px-3 text-left text-[13px] font-semibold transition ${tab() === route.id ? 'active-nav' : 'text-ice-300 hover:bg-white/[0.045] hover:text-white'}`}><Icon size={17} strokeWidth={1.8}/><span>{t(route.key)}</span><Show when={tab() === route.id}><ArrowRight class="ml-auto text-aqua-300" size={15}/></Show></button>; }}</For></nav>
        <div class="mt-8 mb-2 px-3 text-[10px] font-bold uppercase tracking-[.2em] text-ice-500">{t('server')}</div>
        <div class="mx-1 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3"><div class="flex items-center gap-2 text-xs font-semibold"><span class={`status-dot ${connected() ? 'online' : ''}`}></span>{connected() ? 'Griffin local' : t('disconnected')}</div><div class="mt-2 truncate pl-4 text-[11px] text-ice-500">{address().replace('https://', '')}</div></div>
        <div class="mt-auto rounded-xl border border-white/[0.07] bg-[#191c1e] p-3.5"><div class="mb-2 flex items-center gap-2 text-xs font-bold text-ice-100"><Activity size={15} class="text-aqua-300"/>{t('liveConsole')}</div><p class="m-0 text-[11px] leading-relaxed text-ice-500">{lastAction() || t('waitingServer')}</p><div class="mt-3 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-ice-500"><span class={`status-dot ${connected() ? 'online' : ''}`}></span>{connected() ? t('secureLink') : t('waitingServer')}</div></div>
        <div class="mt-4 flex items-center justify-between px-2 text-[10px] text-ice-500"><span>{t('localBuild')}</span><span>v0.2</span></div>
      </aside>

      <main class="main-canvas relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <header class="topbar flex h-[76px] shrink-0 items-center justify-between border-b border-white/[0.07] px-8">
          <div><div class="text-[10px] font-bold uppercase tracking-[.2em] text-ice-500">Griffin Server / <span class="text-aqua-300">{t(routeDefs.find((route) => route.id === tab())!.key)}</span></div><h1 class="mt-1 text-[19px] font-bold tracking-wide">{tab() === 'overview' ? t('center') : tab() === 'accounts' ? t('accountAdmin') : tab() === 'operations' ? t('gameOps') : t('serverCommands')}</h1></div>
          <div class="flex items-center gap-3"><div class="hidden items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-[11px] text-ice-300 xl:flex"><Server size={14} class="text-aqua-300"/> {address()}</div><div class={`connection-pill flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px] font-bold ${connected() ? 'border-aqua-400/20 bg-aqua-400/[0.07] text-aqua-300' : 'border-white/[0.08] bg-white/[0.025] text-ice-500'}`}><Wifi size={14}/>{connected() ? t('online') : t('offline')}</div><Show when={connected()}><button class="icon-button" title={t('disconnect')} onClick={disconnect}><LogOut size={16}/></button></Show></div>
        </header>

        <div class="content-scroll flex-1 overflow-y-auto px-8 py-7">
          <Show when={!connected()}><section class="connect-card relative mx-auto mb-7 max-w-[1040px] overflow-hidden rounded-2xl border border-aqua-300/15 bg-ink-900 p-6 shadow-[0_25px_100px_#0004]"><div class="connect-glow pointer-events-none absolute -right-10 -top-24 size-80 rounded-full bg-aqua-400/[0.09] blur-3xl"></div><div class="relative flex items-start justify-between gap-8"><div class="max-w-lg"><div class="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.2em] text-aqua-300"><ShieldCheck size={14}/>{t('adminAccess')}</div><h2 class="m-0 text-xl font-bold">{t('connectTitle')}</h2><p class="mb-0 mt-2 text-sm leading-relaxed text-ice-500">{t('connectDescription')}</p></div><form class="grid w-[540px] grid-cols-[1fr_1.3fr_auto] items-end gap-2" onSubmit={(e) => { e.preventDefault(); void connect(); }}><label class="text-[10px] font-bold uppercase tracking-wider text-ice-500">{t('serverAddress')}<input class="input-field mt-1.5 w-full" value={address()} onInput={(e) => setAddress(e.currentTarget.value)} /></label><label class="text-[10px] font-bold uppercase tracking-wider text-ice-500">{t('token')}<input class="input-field mt-1.5 w-full" type="password" autocomplete="off" value={token()} onInput={(e) => setToken(e.currentTarget.value)} placeholder={t('tokenPlaceholder')} /></label><button class="primary-button h-[40px]" disabled={busy()}>{busy() ? <LoaderCircle class="animate-spin" size={16}/> : <ArrowRight size={16}/>} {busy() ? t('connecting') : t('connect')}</button></form></div></section></Show>

          <Show when={tab() === 'overview'}><div class="mb-6 flex items-end justify-between"><div><h2 class="section-title">{t('serverState')}</h2><p class="section-subtitle">{t('serverStateHint')}</p></div><button class="quiet-button" disabled={!connected() || busy()} onClick={() => void refreshStatus()}><RefreshCw size={14}/> {t('refresh')}</button></div><div class="mb-6 grid grid-cols-4 gap-4"><StatCard icon={Gauge} label={t('uptime')} value={status() ? `${Math.floor(status()!.uptimeSeconds / 3600)}h ${Math.floor(status()!.uptimeSeconds % 3600 / 60)}m` : '—'} hint={t('process')} tone="aqua"/><StatCard icon={Database} label={t('database')} value={status()?.database ?? '—'} hint={t('postgres')} tone="blue"/><StatCard icon={Users} label={t('playersOnline')} value={status()?.online?.toString() ?? '—'} hint={t('sessions')} tone="amber"/><StatCard icon={ShieldCheck} label={t('accounts')} value={status()?.accounts?.toLocaleString() ?? '—'} hint={t('registered')} tone="violet"/></div><div class="grid grid-cols-[1.35fr_.85fr] gap-4"><section class="surface-card min-h-[310px] p-5"><div class="mb-4 flex items-center justify-between"><div><h3 class="card-title">{t('recentActivity')}</h3><p class="card-caption">{t('sessionLog')}</p></div><span class="tiny-chip"><Activity size={12}/> LIVE</span></div><div class="flex items-start gap-3 border-t border-white/[0.06] py-4"><div class="activity-icon"><ShieldCheck size={15}/></div><div class="min-w-0"><div class="text-[13px] font-semibold">{lastAction() || t('waitingServer')}</div><div class="mt-1 text-[11px] text-ice-500">{t('auditSaved')}</div></div><span class="ml-auto whitespace-nowrap text-[10px] text-ice-500">{t('now')}</span></div><div class="empty-log mt-5"><Activity size={18}/><span>{t('newOps')}</span></div></section><section class="surface-card p-5"><div class="mb-4"><h3 class="card-title">{t('shortcuts')}</h3><p class="card-caption">{t('adminTools')}</p></div><QuickRow icon={Users} title={t('findAccount')} subtitle={t('accountState')} onClick={() => setTab('accounts')}/><QuickRow icon={Gift} title={t('manageInventory')} subtitle={t('inventoryTools')} onClick={() => setTab('operations')} amber/><QuickRow icon={Command} title={t('controlledConsole')} subtitle={t('allowedCommands')} onClick={() => setTab('commands')} violet/><div class="mt-4 rounded-lg border border-white/[0.06] bg-black/10 p-3 text-[11px] leading-relaxed text-ice-500"><CircleHelp size={14} class="mr-2 inline text-aqua-300"/>{t('compatibleData')}</div></section></div></Show>

          <Show when={tab() === 'accounts'}><div class="mb-5"><h2 class="section-title">{t('playerAccounts')}</h2><p class="section-subtitle">{t('accountSearchHint')}</p></div><div class="grid grid-cols-[.9fr_1.1fr] gap-4"><section class="surface-card overflow-hidden"><div class="border-b border-white/[0.06] p-4"><form class="flex gap-2" onSubmit={(e) => {e.preventDefault(); void searchAccounts();}}><div class="search-field"><Search size={15}/><input aria-label={t('searchUidEmail')} placeholder={t('emailPlaceholder')} value={accountQuery()} onInput={(e) => setAccountQuery(e.currentTarget.value)}/></div><button class="primary-button square" title={t('search')}><Search size={16}/></button></form><div class="mt-3 flex items-center justify-between text-[10px] text-ice-500"><span>{accounts().length} {t('results')}</span><button class="text-button" onClick={() => void searchAccounts()}><RefreshCw size={12}/> {t('queryRefresh')}</button></div></div><div class="max-h-[560px] overflow-auto"><Show when={accounts().length > 0} fallback={<div class="empty-state"><Search size={21}/><span>{t('searchAccountHint')}</span></div>}><For each={accounts()}>{(account) => <button class={`account-row ${account.selected ? 'selected' : ''}`} onClick={() => void openAccount(account)}><span class="avatar">{String(account.uid).slice(-2)}</span><span class="min-w-0 flex-1 text-left"><b>{account.email || t('guestAccount')}</b><small>UID {account.uid} · {account.isGuest ? t('guest') : t('account')}</small></span><span class="text-right"><i class={`status-dot ${account.selected ? 'online' : ''}`}></i><small class="block">{account.timeLastLogin ? new Date(account.timeLastLogin).toLocaleDateString(language()) : '—'}</small></span></button>}</For></Show></div></section><section class="surface-card min-h-[360px] overflow-hidden"><Show when={accountDetail()} fallback={<div class="empty-state h-full"><Users size={24}/><span>{t('selectAccount')}</span></div>}>{(detail) => { const a = detail().account as Record<string, unknown> | undefined; const inv = detail().inventory as Record<string, unknown> | undefined; const list = (key: string) => Array.isArray(inv?.[key]) ? inv?.[key] as unknown[] : []; return <><div class="flex items-center justify-between border-b border-white/[0.06] p-5"><div><div class="text-[10px] font-bold uppercase tracking-[.17em] text-aqua-300">{t('profile')}</div><h3 class="mt-1 text-lg font-bold">{String(a?.email || t('guest'))}</h3><div class="mt-1 text-xs text-ice-500">UID {String(a?.uid ?? '')}</div></div><div class="flex items-center gap-3"><span class={`tiny-chip ${detail().online ? '' : 'muted-chip'}`}><i class={`status-dot ${detail().online ? 'online' : ''}`}></i>{detail().online ? t('onlineStatus') : t('offlineStatus')}</span><button class="danger-button account-delete-button" disabled={!connected() || busy() || detail().online === true} onClick={() => void deleteSelectedAccount()} title={detail().online === true ? t('deleteAccountOffline') : t('deleteAccount') }><Trash2 size={14}/>{t('deleteAccount')}</button></div></div><Show when={detail().online}><div class="border-b border-white/[0.06] px-5 py-2 text-[11px] text-ice-500">{t('deleteAccountOffline')}</div></Show><div class="grid grid-cols-3 gap-2 border-b border-white/[0.06] p-4">{[[t('characters'), list('guns').length], [t('weapons'), list('weapons').length], [t('objects'), list('items').length], [t('costumes'), list('costumes').length], [t('modules'), list('weaponMods').length], [t('backgrounds'), list('backgrounds').length]].map(([label, value]) => <div class="metric-tile"><span>{label}</span><b>{value}</b></div>)}</div><div class="p-4"><div class="mb-2 text-[10px] font-bold uppercase tracking-widest text-ice-500">{t('characterState')}</div><div class="max-h-[300px] overflow-auto"><For each={(list('guns') as Record<string, unknown>[])}>{(gun) => <div class="detail-row"><span class="grid size-8 place-items-center rounded-md bg-aqua-400/10 text-[10px] font-bold text-aqua-300">{String(gun.gunId).slice(-3)}</span><span class="flex-1 text-xs">{t('character')} {String(gun.gunId)}</span><span class="text-xs font-bold text-ice-300">{t('levelShort')} {String(gun.level)}</span><span class="text-[10px] text-ice-500">{t('bond')} {String(gun.loveLevel)}</span></div>}</For><For each={(list('items') as Record<string, unknown>[]).slice(0, 18)}>{(item) => <div class="detail-row"><span class="grid size-8 place-items-center rounded-md bg-amber-300/10 text-amber-300"><Package size={15}/></span><span class="flex-1 text-xs">{t('item')} {String(item.itemId)}</span><span class="text-xs font-bold text-ice-300">×{String(item.count)}</span><span class="text-[10px] text-ice-500">{Number(item.type) === 1 ? t('resource') : t('itemLabel')}</span></div>}</For></div></div></>; }}</Show></section></div></Show>

          <Show when={tab() === 'operations'}><div class="mb-5"><h2 class="section-title">{t('operationsTitle')}</h2><p class="section-subtitle">{t('operationsHint')}</p></div><div class="grid grid-cols-2 gap-4">
            <form class="surface-card operation-card" onSubmit={grantItem}><OperationHeading icon={Gift} title={t('grantObject')} subtitle={t('objectHint')} number="01" tone="aqua"/><Field label={t('accountUid')}><input class="input-field" inputmode="numeric" placeholder="100001" value={itemUid()} onInput={(e) => setItemUid(e.currentTarget.value)}/></Field><Field label={t('searchItem')}><CatalogPicker language={language()} nameMode="item-weapon" id="items" total={localCatalog().items.length} entries={filteredItems()} selectedId={Number(itemId())} query={itemSearch()} placeholder={t('itemSearchPlaceholder')} empty={t('noMatches')} resultsLabel={t('catalogResults')} onQuery={(value) => { setItemSearch(value); setItemId(''); }} choose={(entry) => { setItemId(String(entry.id)); setItemSearch(itemWeaponName(entry, language())); }} /></Field><div class="selection-summary"><Show when={selectedItem()}>{(entry) => <><Show when={entry().image}><img src={entry().image} alt=""/></Show><span>{itemWeaponName(entry(), language())} <small>#{entry().id}</small></span></>}</Show><Show when={!selectedItem()}><span>{t('chooseItem')}</span></Show></div><Field label={t('quantity')}><input class="input-field" type="number" min="1" max="1000000" value={itemCount()} onInput={(e) => setItemCount(e.currentTarget.value)}/></Field><button class="primary-button mt-2 w-full" disabled={!connected() || busy() || !selectedItem()}><Plus size={15}/>{t('grantToAccount')}</button></form>

            <form class="surface-card operation-card" onSubmit={grantGun}><OperationHeading icon={Users} title={t('grantCharacter')} subtitle={t('characterHint')} number="02" tone="violet"/><Field label={t('accountUid')}><input class="input-field" inputmode="numeric" placeholder="100001" value={gunUid()} onInput={(e) => setGunUid(e.currentTarget.value)}/></Field><Field label={t('searchCharacter')}><CatalogPicker language={language()} id="characters" entries={filteredCharacters()} selectedId={Number(gunId())} query={gunSearch()} placeholder={t('characterSearchPlaceholder')} empty={t('noMatches')} resultsLabel={t('catalogResults')} onQuery={(value) => { setGunSearch(value); setGunId(''); setChosenCostumes([]); }} choose={(entry) => { setGunId(String(entry.id)); setGunSearch(catalogName(entry, language())); setChosenCostumes([]); }} /></Field><div class="selection-summary"><Show when={selectedCharacter()}>{(entry) => <><img src={entry().image || undefined} alt=""/><span>{t('selectedCharacter')}: {catalogName(entry(), language())} <small>#{entry().id}</small></span></>}</Show><Show when={!selectedCharacter()}><span>{t('chooseCharacter')}</span></Show></div><Field label={t('level')}><input class="input-field" type="number" min="1" max="60" value={gunLevel()} onInput={(e) => setGunLevel(e.currentTarget.value)}/></Field><Show when={selectedCharacter()}><SkinGallery title={t('skinsHeading')} selectedLabel={t('skinsSelected')} allLabel={t('selectAll')} noneLabel={t('clearSelection')} empty={t('noSkinsFor')} language={language()} entries={costumesOfSelected()} chosen={chosenCostumes()} toggle={(id) => toggleIn(chosenCostumes, setChosenCostumes, id)} setAll={(ids) => setChosenCostumes(ids)} nameMode="character"/></Show><button class="primary-button mt-2 w-full" disabled={!connected() || busy() || !selectedCharacter()}><Zap size={15}/>{chosenCostumes().length ? t('applyWithSkins') : t('applyCharacter')}</button></form>

            <form class="surface-card operation-card" onSubmit={grantWeapon}><OperationHeading icon={Boxes} title={t('grantWeapon')} subtitle={t('weaponHint')} number="03" tone="amber"/><Field label={t('accountUid')}><input class="input-field" inputmode="numeric" placeholder="100001" value={weaponUid()} onInput={(e) => setWeaponUid(e.currentTarget.value)}/></Field><Field label={t('searchWeapon')}><CatalogPicker language={language()} nameMode="item-weapon" id="weapons" entries={filteredWeapons()} selectedId={Number(weaponId())} query={weaponSearch()} placeholder={t('weaponSearchPlaceholder')} empty={t('noMatches')} resultsLabel={t('catalogResults')} onQuery={(value) => { setWeaponSearch(value); setWeaponId(''); setChosenSkins([]); }} choose={(entry) => { setWeaponId(String(entry.id)); setWeaponSearch(itemWeaponName(entry, language())); setChosenSkins([]); }} /></Field><div class="selection-summary"><Show when={selectedWeapon()}>{(entry) => <><img src={entry().image || undefined} alt=""/><span>{t('selectedCharacter')}: {itemWeaponName(entry(), language())} <small>#{entry().id}</small></span></>}</Show><Show when={!selectedWeapon()}><span>{t('chooseWeapon')}</span></Show></div><Field label={t('copies')}><input class="input-field" type="number" min="1" max="50" value={weaponCount()} onInput={(e) => setWeaponCount(e.currentTarget.value)}/></Field><Show when={selectedWeapon()}><SkinGallery title={t('skinsHeading')} selectedLabel={t('skinsSelected')} allLabel={t('selectAll')} noneLabel={t('clearSelection')} empty={t('noSkinsFor')} language={language()} entries={skinsOfSelected()} chosen={chosenSkins()} toggle={(id) => toggleIn(chosenSkins, setChosenSkins, id)} setAll={(ids) => setChosenSkins(ids)} nameMode="item-weapon"/></Show><button class="primary-button mt-2 w-full" disabled={!connected() || busy() || !selectedWeapon()}><Plus size={15}/>{chosenSkins().length ? t('addWithSkins') : t('addWeapon')}</button></form>

            <form class="surface-card operation-card danger-card" onSubmit={cleanInventory}><OperationHeading icon={Trash2} title={t('resetAmounts')} subtitle={t('resetHint')} number="04" tone="rose"/><Field label={t('accountUid')}><input class="input-field" inputmode="numeric" placeholder="100001" value={cleanUid()} onInput={(e) => setCleanUid(e.currentTarget.value)}/></Field><Field label={t('group')}><select class="input-field" value={cleanType()} onChange={(e) => setCleanType(e.currentTarget.value)}><option value="items">{t('allItems')}</option><option value="resources">{t('resources')}</option></select></Field><button class="danger-button mt-4 w-full" disabled={!connected() || busy()}><Trash2 size={15}/>{t('resetButton')}</button></form>
          </div><Show when={notice()}>{(n) => <div class={`result-banner mt-4 ${n().error ? 'error-banner' : ''}`}><Check size={15}/><span>{n().text}</span></div>}</Show></Show>

          <Show when={tab() === 'commands'}><div class="mb-5"><h2 class="section-title">{t('permittedCommands')}</h2><p class="section-subtitle">{t('commandHint')}</p></div><div class="grid grid-cols-[.8fr_1.2fr] gap-4"><section class="surface-card overflow-hidden"><div class="border-b border-white/[0.06] p-4"><h3 class="card-title">{t('commandRegistry')}</h3><p class="card-caption">{t('noShell')}</p></div><div class="max-h-[500px] overflow-auto"><Show when={commands().length} fallback={<div class="empty-state">{connected() ? t('noCommands') : t('connectLoad')}</div>}><For each={commands()}>{(cmd) => <button class="command-row" onClick={() => setCommandText(cmd.usage || cmd.name)}><span class="command-mark"><Command size={15}/></span><span class="min-w-0 flex-1 text-left"><b>{cmd.name}</b><small>{cmd.description}</small></span><ArrowRight size={14} class="text-ice-500"/></button>}</For></Show></div></section><section class="surface-card p-5"><div class="mb-4 flex items-center justify-between"><div><h3 class="card-title">{t('console')}</h3><p class="card-caption">{t('argsValidated')}</p></div><span class="tiny-chip"><TerminalSquare size={12}/> GM CONSOLE</span></div><form onSubmit={executeCommand}><div class="command-input-wrap"><span class="text-aqua-300">griffin</span><span class="text-ice-500">›</span><input value={commandText()} onInput={(e) => setCommandText(e.currentTarget.value)} placeholder={t('commandPlaceholder')}/></div><button class="primary-button mt-3" disabled={!connected() || busy()}><Command size={15}/>{t('execute')}</button></form><div class="mt-5"><div class="mb-2 text-[10px] font-bold uppercase tracking-widest text-ice-500">{t('output')}</div><pre class="command-output">{commandResult() || t('outputPlaceholder')}</pre></div></section></div></Show>
        </div>
        <footer class="flex h-9 shrink-0 items-center justify-between border-t border-white/[0.06] px-8 text-[10px] text-ice-500"><span class="flex items-center gap-2"><span class={`status-dot ${connected() ? 'online' : ''}`}></span>{connected() ? t('activeChannel') : t('inactiveChannel')} <span class="text-white/15">/</span> {t('loopback')}</span><span class="flex items-center gap-1.5"><ShieldCheck size={12}/>{t('protectedBy')}</span></footer>
      </main>
      <Show when={notice()}>{(n) => <div class={`toast ${n().error ? 'toast-error' : ''}`}><span class="toast-icon">{n().error ? <X size={15}/> : <Check size={15}/>}</span><span class="min-w-0">{n().text}</span><button class="ml-auto text-ice-500 hover:text-white" onClick={() => setNotice(undefined)}><X size={14}/></button></div>}</Show>
    </div>
  );
}

function StatCard(props: { icon: typeof Gauge; label: string; value: string; hint: string; tone: string }) { const Icon = props.icon; return <div class="stat-card"><div class="flex items-start justify-between"><span class={`stat-icon ${props.tone}`}><Icon size={17}/></span><span class="stat-signal"><i></i><i></i><i></i><i></i></span></div><div class="mt-4 text-[10px] font-bold uppercase tracking-[.16em] text-ice-500">{props.label}</div><div class="mt-1 text-[26px] font-bold tracking-tight text-ice-100">{props.value}</div><div class="mt-1 text-[11px] text-ice-500">{props.hint}</div></div>; }
function Field(props: { label: string; children: JSX.Element }) { return <label class="field-label">{props.label}{props.children}</label>; }
function OperationHeading(props: { icon: typeof Gift; title: string; subtitle: string; number: string; tone: string }) { const Icon = props.icon; return <div class="operation-heading"><span class={`operation-icon ${props.tone}`}><Icon size={18}/></span><div><h3>{props.title}</h3><p>{props.subtitle}</p></div><span class="operation-number">{props.number}</span></div>; }
function QuickRow(props: { icon: typeof Users; title: string; subtitle: string; onClick: () => void; amber?: boolean; violet?: boolean }) { const Icon = props.icon; return <button class="quick-row" onClick={props.onClick}><span class={`quick-icon ${props.amber ? 'amber' : props.violet ? 'violet' : ''}`}><Icon size={17}/></span><span><b>{props.title}</b><small>{props.subtitle}</small></span><ArrowRight size={15} class="ml-auto text-ice-500"/></button>; }
function SkinGallery(props: { title: string; selectedLabel: string; allLabel: string; noneLabel: string; empty: string; language: Language; nameMode: 'character' | 'item-weapon'; entries: CatalogEntry[]; chosen: number[]; toggle: (id: number) => void; setAll: (ids: number[]) => void }) {
  return <div class="skin-gallery">
    <div class="skin-gallery-head"><b>{props.title}</b><span>{props.chosen.length}/{props.entries.length} {props.selectedLabel}</span>
      <button type="button" class="text-button" onClick={() => props.setAll(props.entries.map((entry) => entry.id))}>{props.allLabel}</button>
      <button type="button" class="text-button" onClick={() => props.setAll([])}>{props.noneLabel}</button></div>
    <Show when={props.entries.length > 0} fallback={<div class="catalog-empty">{props.empty}</div>}>
      <div class="skin-grid"><For each={props.entries}>{(entry) => <button type="button" aria-pressed={props.chosen.includes(entry.id)} class={`skin-tile ${props.chosen.includes(entry.id) ? 'chosen' : ''}`} onClick={() => props.toggle(entry.id)}>
        <span class="skin-art"><Show when={entry.image}><img src={entry.image} alt="" loading="lazy"/></Show><i class="skin-check"><Check size={12}/></i></span>
        <span class="skin-name">{props.nameMode === 'character' ? catalogName(entry, props.language) : itemWeaponName(entry, props.language)}</span><code>#{entry.id}</code></button>}</For></div>
    </Show>
  </div>;
}

function CatalogPicker(props: { total?: number; id: string; language: Language; nameMode?: 'item-weapon'; entries: CatalogEntry[]; selectedId: number; query: string; placeholder: string; empty: string; resultsLabel: string; onQuery: (query: string) => void; choose: (entry: CatalogEntry) => void }) {
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  let blurTimer: number | undefined;
  onCleanup(() => { if (blurTimer) window.clearTimeout(blurTimer); });
  const chooseAt = (index: number) => {
    const entry = props.entries[index];
    if (!entry) return;
    props.choose(entry);
    setActiveIndex(0);
    setOpen(false);
  };
  return <div class={`catalog-picker ${open() ? 'catalog-picker-open' : ''}`}>
    <div class="catalog-input-wrap"><Search size={15}/><input aria-label={props.placeholder} role="combobox" aria-autocomplete="list" aria-expanded={open()} aria-controls={`catalog-options-${props.id}`} placeholder={props.placeholder} value={props.query} onFocus={() => { setOpen(true); setActiveIndex(0); }} onBlur={() => { blurTimer = window.setTimeout(() => setOpen(false), 180); }} onInput={(event) => { props.onQuery(event.currentTarget.value); setActiveIndex(0); setOpen(true); }} onKeyDown={(event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActiveIndex((index) => Math.min(index + 1, props.entries.length - 1)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
      else if (event.key === 'Enter' && open()) { event.preventDefault(); chooseAt(activeIndex()); }
      else if (event.key === 'Escape') setOpen(false);
    }}/><button type="button" class="catalog-toggle" aria-label="Open catalog" aria-expanded={open()} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}><span class={`catalog-chevron ${open() ? 'expanded' : ''}`}></span></button></div>
    <Show when={open()}><div class="catalog-dropdown" id={`catalog-options-${props.id}`} role="listbox"><Show when={props.entries.length > 0} fallback={<div class="catalog-empty">{props.empty}</div>}><div class="catalog-result-count">{props.entries.length}{props.total && props.total > props.entries.length ? ` / ${props.total}` : ''} · {props.resultsLabel}</div><For each={props.entries}>{(entry, index) => <button type="button" role="option" aria-selected={props.selectedId === entry.id} class={`catalog-option ${props.selectedId === entry.id ? 'selected' : ''} ${activeIndex() === index() ? 'keyboard-active' : ''}`} onMouseEnter={() => setActiveIndex(index())} onMouseDown={(event) => event.preventDefault()} onClick={() => chooseAt(index())}><span class="catalog-option-image"><Show when={entry.image} fallback={<span>{entry.id.toString().slice(-3)}</span>}><img src={entry.image} alt="" loading="lazy" /></Show></span><span class="catalog-option-copy"><b>{pickerName(entry, props.language, props.nameMode)}</b><Show when={displayCatalogAlias(entry, props.language, props.nameMode)}>{(alias) => <small>{alias()}</small>}</Show></span><code>#{entry.id}</code></button>}</For></Show></div></Show>
  </div>;
}

function normalizeCatalogQuery(value: string) {
  return value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}

function catalogName(entry: CatalogEntry, locale: Language) {
  return entry.names?.[locale as 'en' | 'es'] || (locale === 'es' ? entry.names?.en : undefined) || entry.name;
}

function catalogSearchText(entry: CatalogEntry) {
  return `${entry.name} ${entry.displayName ?? ''} ${Object.values(entry.names ?? {}).join(' ')} ${entry.aliases?.join(' ')} ${entry.id}`;
}

function itemWeaponName(entry: CatalogEntry, locale: Language) {
  return locale === 'zh' ? entry.displayName || entry.name : entry.names?.en || entry.displayName || entry.name;
}

function pickerName(entry: CatalogEntry, locale: Language, mode?: 'item-weapon') {
  return mode === 'item-weapon' ? itemWeaponName(entry, locale) : catalogName(entry, locale);
}

function displayCatalogAlias(entry: CatalogEntry, locale: Language, mode?: 'item-weapon') {
  if (mode === 'item-weapon') return undefined;
  const currentName = pickerName(entry, locale, mode);
  return entry.aliases?.find((alias) => alias !== currentName && !(mode === 'item-weapon' && locale !== 'zh' && alias === entry.names?.es) && /^[\p{L}\p{N} -]+$/u.test(alias) && !alias.includes('_') && !/^\d+$/.test(alias));
}
