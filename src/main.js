// Точка входа: состояние, обновление, отрисовка.
import './styles.css';
import { debounce, escapeHtml, LABEL } from './util.js';
import { parseGrammar } from './grammar/parser.js';
import { analyzeGrammar } from './grammar/analyze.js';
import { lex } from './lexer/lexer.js';
import { rdParse, walkRules, deepestAt } from './parser/rd.js';
import { pseudocode } from './parser/pseudocode.js';
import { generate } from './cpu8/codegen.js';
import { runCPU8 } from './cpu8/cpu8.js';
import { createEditor } from './ui/editor.js';
import { highlightBnf, highlightProgram } from './ui/highlighters.js';
import { GRAMMAR_PRESETS, PROGRAM_CHIPS } from './data/presets.js';

const $ = (sel) => document.querySelector(sel);
const STORAGE_KEY = 'bnflab:v1';

// ---------------------------------------------------------------- состояние

const state = {
  grammar: GRAMMAR_PRESETS[0].grammar,
  source: GRAMMAR_PRESETS[0].source,
  presetId: GRAMMAR_PRESETS[0].id,
  strictNumbers: true,
  comments: false,
  tab: 1,
  theme: 'light',
};
try {
  Object.assign(state, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
} catch { /* первый запуск */ }

const save = debounce(() => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* приватный режим */ }
}, 350);

let lastAnalysis = null;
let lastLexed = { tokens: [], errors: [], skipped: [] };
let lastParsedSrc = null; // AST исходной БНФ — для псевдокода
let curAst = null;
let curTokens = [];
let parseSel = null; // [start, end) — выбранный диапазон лексем

// ---------------------------------------------------------------- редакторы

const gEditor = createEditor($('#g-editor'), {
  value: state.grammar,
  highlight: highlightBnf,
  onChange: (v) => { state.grammar = v; markPresetCustom(); save(); scheduleUpdate(); },
});

const pEditor = createEditor($('#p-editor'), {
  value: state.source,
  highlight: (t) => highlightProgram(t, lastLexed),
  onChange: (v) => { state.source = v; save(); scheduleUpdate(); },
});

const scheduleUpdate = debounce(update, 120);

// ---------------------------------------------------------------- обновление

function update() {
  const parsed = parseGrammar(state.grammar);
  lastParsedSrc = parsed;
  lastAnalysis = analyzeGrammar(parsed);
  const info = lastAnalysis.info;

  lastLexed = lex(state.source, {
    keywords: new Set(info.keywords),
    puncts: new Set(info.puncts),
    strictNumbers: state.strictNumbers,
    comments: state.comments,
  });

  pEditor.repaint();
  renderStats(info);
  renderDiagnostics(lastAnalysis.diagnostics);
  renderTokens(info);
  renderPseudocode();
  renderParseTab();
}

// ---------------------------------------------------------------- отрисовка

function renderStats(info) {
  const el = $('#grammar-stats');
  if (!info.nonterminals) {
    el.innerHTML = '<span class="chip muted">правил пока нет — выберите пример или начните писать</span>';
    return;
  }
  const parts = [];
  if (lastAnalysis.start) parts.push(`<span class="chip c-start"><span class="k">старт</span> &lt;${escapeHtml(lastAnalysis.start)}&gt;</span>`);
  parts.push(`<span class="chip"><span class="k">правил</span> ${info.nonterminals}</span>`);
  if (info.keywords.length)
    parts.push(`<span class="chip"><span class="k">ключи</span>&nbsp; ${info.keywords.map(escapeHtml).join(', ')}</span>`);
  if (info.puncts.length)
    parts.push(`<span class="chip"><span class="k">знаки</span>&nbsp; ${info.puncts.map(escapeHtml).join(' ')}</span>`);
  if (info.classes.length)
    parts.push(`<span class="chip"><span class="k">классы</span>&nbsp; ${info.classes.map(escapeHtml).join(', ')}</span>`);
  el.innerHTML = parts.join('');
}

function renderDiagnostics(diags) {
  const el = $('#diagnostics');
  if (!diags.length) {
    el.innerHTML = lastAnalysis.info.nonterminals
      ? '<div class="ok-box">✓ Грамматика корректна: все правила определены и достижимы, левой рекурсии нет.</div>'
      : '<div class="diag sev-info"><span class="sev">i</span><span class="msg">Правил пока нет. Выберите пример из списка или запишите первое правило: <code>&lt;программа&gt; ::= …</code></span></div>';
    return;
  }
  const icon = { error: '✕', warn: '!', info: 'i' };
  el.innerHTML = diags.map((d) => `
    <div class="diag sev-${d.severity}">
      <span class="sev">${icon[d.severity]}</span>
      <span class="msg">${escapeHtml(d.message)}</span>
      <button class="jump" data-line="${d.line}">стр. ${d.line}</button>
    </div>`).join('');
  el.querySelectorAll('.jump').forEach((b) =>
    b.addEventListener('click', () => gEditor.focusLine(Number(b.dataset.line))));
}

function coverageWarnings(info) {
  const seen = new Set();
  const items = [];
  const push = (key, html) => { if (!seen.has(key)) { seen.add(key); items.push(`<div class="warn-box">⚠ ${html}</div>`); } };
  for (const t of lastLexed.tokens) {
    if (t.kind === 'ident' && !info.classSet.has('ИДЕНТ'))
      push('ИДЕНТ', `в грамматике не используется класс <b>ИДЕНТ</b> — идентификаторы не попадут ни в одно правило`);
    if (t.kind === 'num' && !info.classSet.has('ЧИСЛО'))
      push('ЧИСЛО', `в грамматике не используется класс <b>ЧИСЛО</b> — числа не попадут ни в одно правило`);
    if (t.kind === 'kw' && !info.literals.has(t.text))
      push('kw:' + t.text, `ключевое слово <b>«${escapeHtml(t.text)}»</b> встречается в программе, но его нет ни в одном правиле грамматики`);
    if (t.kind === 'op' && !info.literals.has(t.text))
      push('op:' + t.text, `знак <b>«${escapeHtml(t.text)}»</b> встречается в программе, но его нет ни в одном правиле грамматики`);
  }
  return items;
}

function renderTokens(info) {
  const { tokens, errors } = lastLexed;

  $('#token-count').textContent = tokens.length
    ? `— ${tokens.length} шт.${errors.length ? `, ошибок: ${errors.length}` : ''}`
    : '— пока пусто';

  $('#lexer-errors').innerHTML = errors.map((e) =>
    `<div class="err-box"><b>${e.line}:${e.col}</b> — ${escapeHtml(e.message)}</div>`).join('');

  $('#coverage').innerHTML = lastAnalysis?.start ? coverageWarnings(info).join('') : '';

  const counts = new Map();
  for (const t of tokens) counts.set(t.kind, (counts.get(t.kind) || 0) + 1);
  $('#token-legend').innerHTML = [...counts.entries()].map(([kind, n]) =>
    `<span class="legend"><span class="dot d-${kind}"></span>${LABEL[kind]} × ${n}</span>`).join('');

  const cls = { num: 'num', ident: 'ident', kw: 'kw', op: 'op', err: 'err' };
  $('#token-table tbody').innerHTML = tokens.map((t, i) => `
    <tr>
      <td class="t-pos">${i + 1}</td>
      <td class="t-lex"><span class="${cls[t.kind] || 'op'}">${escapeHtml(t.text)}</span></td>
      <td><span class="kind-pill">${LABEL[t.kind]}</span></td>
      <td class="t-pos">${t.line}:${t.col}</td>
      <td class="t-note${t.warn ? ' warn' : ''}">${escapeHtml(t.warn || t.note || '')}</td>
    </tr>`).join('');
}

// ---------------------------------------------------------------- часть 2: парсер и AST

const TK_CLS = { num: 'num', ident: 'ident', kw: 'kw', op: 'op', err: 'err' };

function renderPseudocode() {
  const el = $('#pseudocode');
  const blocks = lastParsedSrc ? pseudocode(lastParsedSrc.rules) : [];
  if (!blocks.length) {
    el.innerHTML = '<span class="muted">правил нет — псевдокод появится вместе с грамматикой</span>';
    return;
  }
  el.innerHTML = blocks.map((b) => {
    const nl = b.text.indexOf('\n');
    const head = escapeHtml(nl === -1 ? b.text : b.text.slice(0, nl));
    const body = nl === -1 ? '' : `<div>${escapeHtml(b.text.slice(nl + 1))}</div>`;
    const callout = b.rec
      ? '<div class="pcallout"># левая рекурсия правила стала циклом «пока…» — так же, как на доске в блоке 1</div>'
      : '';
    return `<div class="prule${b.rec ? ' rec' : ''}"><div class="pname">${head}</div>${body}${callout}</div>`;
  }).join('');
}

function renderParseTab() {
  const statusEl = $('#parse-status');
  parseSel = null;
  curAst = null;
  curTokens = lastLexed.tokens;

  if (!lastAnalysis.start) {
    statusEl.innerHTML = '<div class="diag sev-info"><span class="sev">i</span><span class="msg">Начните с грамматики в части 1 — парсер строится прямо по ней.</span></div>';
    $('#token-strip').innerHTML = '';
    $('#ast-tree').innerHTML = '';
    $('#ast-count').textContent = '';
    $('#parse-trace').innerHTML = '';
    $('#parse-steps').textContent = '';
    renderGenerator();
    return;
  }

  const { ast, error, trace, steps } = rdParse(curTokens, lastAnalysis.core, lastAnalysis.start);
  $('#parse-steps').textContent = `вызовов функций: ${steps.toLocaleString('ru-RU')}`;

  const ambig = lastAnalysis.diagnostics.some((d) =>
    /неоднознач|двусмыслен|двояко|два дерева|висяч/.test(d.message));

  let statusHtml = '';
  if (lastLexed.errors.length)
    statusHtml += `<div class="warn-box">⚠ лексер: ошибок ${lastLexed.errors.length} — помеченные красным лексемы не могут попасть ни в одно правило</div>`;
  if (ambig)
    statusHtml += '<div class="warn-box">⚠ грамматика неоднозначна — показан <b>один из возможных</b> разборов. Рукописный парсер решает неоднозначность молча: это его удобство и его опасность</div>';
  if (error)
    statusHtml += `<div class="err-box"><b>✕ ошибка разбора</b> — ${escapeHtml(error.message)}</div>`;
  else if (ast) {
    let n = 0;
    walkRules(ast, () => n++);
    statusHtml = `<div class="ok-box">✓ программа разобрана: ${n} ${plural(n, 'применение правила', 'применения правила', 'применений правила')} — дерево и порядок ниже</div>`;
  }
  statusEl.innerHTML = statusHtml;
  curAst = ast;

  renderStrip();
  renderTree(ast);
  renderTrace(trace);
  renderGenerator();
}

// ---------------------------------------------------------------- часть 2: генератор → TinyCPU-8

let genState = null; // {gen, run?}

function renderGenerator() {
  genState = null;
  const status = $('#gen-status');
  const runBtn = $('#gen-run');
  const copyBtn = $('#gen-copy');
  runBtn.disabled = true;
  copyBtn.disabled = true;
  $('#gen-listing').innerHTML = '';
  $('#gen-data').innerHTML = '';
  $('#gen-size').textContent = '';
  $('#gen-runout').innerHTML = '<span class="muted small">Нажмите «Запустить» — программа выполнится на встроенном эмуляторе.</span>';

  if (!curAst) {
    status.innerHTML = '<div class="muted small">Генератор подождёт успешного разбора: сначала парсер должен построить AST.</div>';
    return;
  }
  let gen;
  try {
    gen = generate(curAst);
  } catch (e) {
    status.innerHTML = `<div class="err-box"><b>✕ генератор отказался</b> — ${escapeHtml(e.message)}</div>`;
    return;
  }
  genState = { gen, run: null };
  runBtn.disabled = false;
  copyBtn.disabled = false;
  status.innerHTML = `<div class="ok-box">✓ Скомпилировано: код ${gen.codeLen} байт + данных ${gen.dataRows.length}. Стек — сверху вниз, пересечений нет.</div>`
    + gen.warnings.map((w) => `<div class="warn-box">⚠ ${escapeHtml(w)}</div>`).join('');
  $('#gen-size').textContent = `— ${gen.bytes.length} байт в память с 0x00`;
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  $('#gen-listing').innerHTML = `<table class="listing"><tbody>${gen.codeRows.map((r) => r.labelName
    ? `<tr class="lab"><td class="t-pos">${hex2(r.addr)}</td><td></td><td class="asm-lab">${escapeHtml(r.labelName)}:</td><td></td></tr>`
    : `<tr><td class="t-pos">${hex2(r.addr)}</td><td class="asm-hex">${r.hex}</td><td class="asm-text">${escapeHtml(r.text)}</td><td class="asm-c">${escapeHtml(r.comment)}</td></tr>`).join('')}</tbody></table>`;
  renderGenData(null);
}

function renderGenData(res) {
  const gen = genState.gen;
  const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  const rows = gen.dataRows.map((r) => {
    const after = res ? res.memory[r.addr] : null;
    const diff = res && after !== r.value;
    return `<tr class="${diff ? 'changed' : ''}"><td class="t-pos">${hex2(r.addr)}</td><td class="mono">${escapeHtml(r.label)}</td><td>${r.value}</td><td>${res ? `<b>${after}</b>` : ''}</td><td class="asm-c">${escapeHtml(r.comment)}</td></tr>`;
  }).join('');
  $('#gen-data').innerHTML = `<table class="listing"><thead><tr><th>адр</th><th>метка</th><th>при старте</th><th>после</th><th>что это</th></tr></thead><tbody>${rows}</tbody></table>`;

  const out = $('#gen-runout');
  if (!res) {
    out.innerHTML = '<span class="muted small">Нажмите «Запустить» — программа выполнится на встроенном эмуляторе, здесь же видно, какие значения легли в ячейки переменных.</span>';
    return;
  }
  if (res.error) {
    out.innerHTML = `<div class="err-box"><b>✕ эмулятор</b> — ${escapeHtml(res.error.message)}</div>`;
    return;
  }
  const vars = gen.dataRows.filter((r) => r.varName);
  out.innerHTML = `<div class="ok-box">✓ halted за ${res.steps} ${plural(res.steps, 'шаг', 'шага', 'шагов')} · A=${res.a} · PC=${res.pc} · SP=${res.sp}</div>`
    + (vars.length
      ? `<div class="vars-out">${vars.map((r) => `<span class="chip c-start"><span class="k">${escapeHtml(r.varName)}</span> ${res.memory[r.addr]}</span>`).join('')}</div>`
      : '<div class="muted small">переменных в программе нет</div>');
}

$('#gen-run').addEventListener('click', () => {
  if (!genState) return;
  const res = runCPU8(genState.gen.bytes, { maxSteps: 500000 });
  genState.run = res;
  renderGenData(res);
});

$('#gen-copy').addEventListener('click', async (e) => {
  if (!genState) return;
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(genState.gen.listing);
    const old = btn.textContent;
    btn.textContent = '✓ Скопировано — вставляйте в tinycpu-web';
    setTimeout(() => { btn.textContent = old; }, 1800);
  } catch {
    prompt('Скопируйте листинг вручную:', genState.gen.listing);
  }
});

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function setSel(s, e) {
  parseSel = (s == null) ? null : [s, e];
  renderStrip();
  renderTree(curAst);
}

function renderStrip() {
  const sel = parseSel;
  $('#token-strip').innerHTML = curTokens.map((t, i) =>
    `<span class="tk${sel && sel[0] <= i && i < sel[1] ? ' sel' : ''}" data-i="${i}" title="строка ${t.line}, столбец ${t.col}"><i>${i + 1}</i><span class="${TK_CLS[t.kind] || 'op'}">${escapeHtml(t.text)}</span></span>`).join('');
  $('#token-strip').querySelectorAll('.tk').forEach((el) => el.addEventListener('click', () => {
    if (!curAst) return;
    const node = deepestAt(curAst, Number(el.dataset.i));
    if (node) setSel(node.start, node.end);
  }));
}

function renderTree(ast) {
  const el = $('#ast-tree');
  if (!ast) {
    el.innerHTML = '<div class="muted">дерева нет — парсер не смог разобрать текущую программу (см. статус выше)</div>';
    $('#ast-count').textContent = '';
    return;
  }
  let count = 0, maxDepth = 0;
  walkRules(ast, (n, d) => { count++; maxDepth = Math.max(maxDepth, d); });
  $('#ast-count').textContent = `— ${count} узлов, глубина ${maxDepth + 1}`;
  el.innerHTML = treeHtml(ast, 0);
  el.querySelectorAll('.trow').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('caret')) return;
      setSel(Number(row.dataset.s), Number(row.dataset.e));
    });
  });
  el.querySelectorAll('.caret').forEach((c) => c.addEventListener('click', (e) => {
    e.stopPropagation();
    c.closest('.tnode').querySelector(':scope > .tkids').classList.toggle('collapsed');
    c.textContent = c.textContent === '▸' ? '▾' : '▸';
  }));
}

function treeHtml(node, depth) {
  if (node.type === 'tok') {
    const i = node.start;
    const sel = parseSel && parseSel[0] === i && i < parseSel[1] ? ' sel' : '';
    return `<span class="tleaf tk-${TK_CLS[node.tok.kind] || 'op'}${sel}" title="лексема ${i + 1}">${escapeHtml(node.tok.text)}</span>`;
  }
  const sel = parseSel && parseSel[0] === node.start && node.end === parseSel[1] ? ' sel' : '';
  const range = node.end > node.start ? `лексемы ${node.start + 1}–${node.end}` : 'ε';
  const kids = node.children.map((c) => treeHtml(c, depth + 1)).join('');
  // крупные поддеревья сворачиваем, чтобы дерево читалось
  const collapsed = depth >= 1 && node.end - node.start > 18;
  return `<div class="tnode">
    <div class="trow${sel}" data-s="${node.start}" data-e="${node.end}" title="правило <${escapeHtml(node.name)}>, ${range}">
      <span class="caret">${collapsed ? '▸' : '▾'}</span><span class="tnt">&lt;${escapeHtml(node.name)}&gt;</span><span class="tnum">${range}</span>
    </div>
    <div class="tkids${collapsed ? ' collapsed' : ''}">${kids}</div>
  </div>`;
}

function renderTrace(trace) {
  const shown = trace.slice(0, 1200);
  $('#parse-trace').innerHTML = shown.map((t) =>
    `<div class="tr" style="--d:${t.d}"><span class="tn">разобрать_${escapeHtml(t.name)}</span><span class="tp">${t.to > t.from ? `${t.from + 1}–${t.to}` : 'ε'}</span></div>`).join('')
    + (trace.length > 1200 ? '<div class="muted">… трасса обрезана</div>' : '')
    || '<div class="muted">трасса появится после успешного разбора</div>';
}

// ---------------------------------------------------------------- пресеты, чипы

const presetSelect = $('#preset-select');
presetSelect.innerHTML =
  GRAMMAR_PRESETS.map((p) => `<option value="${p.id}">${p.label}</option>`).join('') +
  '<option value="custom">Свой вариант</option>';

presetSelect.addEventListener('change', () => {
  const preset = GRAMMAR_PRESETS.find((p) => p.id === presetSelect.value);
  if (!preset) return;
  state.grammar = preset.grammar;
  state.source = preset.source;
  state.presetId = preset.id;
  gEditor.value = state.grammar;
  pEditor.value = state.source;
  save();
  update();
});

function markPresetCustom() {
  const preset = GRAMMAR_PRESETS.find((p) => p.id === state.presetId);
  const isCustom = !preset || preset.grammar !== state.grammar;
  presetSelect.value = isCustom ? 'custom' : preset.id;
}

$('#chips').classList.add('tight');
$('#chips').innerHTML = PROGRAM_CHIPS.map((c, i) =>
  `<button class="chip" data-i="${i}" title="${escapeHtml(c.title)}">${escapeHtml(c.label)}</button>`).join('');
$('#chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-i]');
  if (!btn) return;
  const chip = PROGRAM_CHIPS[Number(btn.dataset.i)];
  state.source = chip.code;
  pEditor.value = chip.code;
  save();
  update();
});

// ---------------------------------------------------------------- опции, вкладки, тема

$('#opt-strict').checked = state.strictNumbers;
$('#opt-comments').checked = state.comments;
$('#opt-strict').addEventListener('change', (e) => { state.strictNumbers = e.target.checked; save(); update(); });
$('#opt-comments').addEventListener('change', (e) => { state.comments = e.target.checked; save(); update(); });

function showTab(n) {
  state.tab = n;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', Number(b.dataset.tab) === n));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = true; });
  $(`#view-${n}`).hidden = false;
  $('#pipeline').style.display = n === 1 ? '' : 'none';
  const h = `#tab${n}`;
  if (location.hash !== h) history.replaceState(null, '', h);
  save();
}
document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => showTab(Number(b.dataset.tab))));
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#tab([123])$/);
  if (m && Number(m[1]) !== state.tab) showTab(Number(m[1]));
});

const themeBtn = $('#theme-toggle');
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  themeBtn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
}
themeBtn.addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  save();
});

// ---------------------------------------------------------------- старт

applyTheme();
const m0 = location.hash.match(/^#tab([123])$/);
showTab(m0 ? Number(m0[1]) : (state.tab === 2 || state.tab === 3 ? state.tab : 1));
markPresetCustom();
update();
