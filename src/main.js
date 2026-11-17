// Точка входа: состояние, обновление, отрисовка.
import './styles.css';
import { debounce, escapeHtml, LABEL } from './util.js';
import { parseGrammar } from './grammar/parser.js';
import { analyzeGrammar } from './grammar/analyze.js';
import { lex } from './lexer/lexer.js';
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
  save();
}
document.querySelectorAll('.tab').forEach((b) =>
  b.addEventListener('click', () => showTab(Number(b.dataset.tab))));

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
showTab(state.tab === 2 || state.tab === 3 ? state.tab : 1);
markPresetCustom();
update();
