import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const webRequire = createRequire(new URL('../web/package.json', import.meta.url));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const source = await readFile(new URL('../web/src/components/DonutChart.tsx', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;
const componentModule = { exports: {} };
new Function('require', 'module', 'exports', output)(webRequire, componentModule, componentModule.exports);
const { DonutChart } = componentModule.exports;

const BLUE = '#2563eb';
const ORANGE = '#f97316';
const GREEN = '#16a34a';
const PENDING = 'var(--border)';

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

function renderChart(props) {
  const html = renderToStaticMarkup(React.createElement(DonutChart, props));
  const circles = [...html.matchAll(/<circle\b([^>]*)>/g)].map((match) => attributes(match[1]));
  assert.ok(circles.length > 0, 'SVG must contain a base ring');
  assert.equal(circles[0].stroke, PENDING);
  assert.equal(circles[0]['stroke-dasharray'], undefined, 'Pending ring must cover the full circumference');
  for (const circle of circles) {
    assert.ok(Number(circle.r) > 0);
    assert.equal(circle.fill, 'none');
    assert.equal(circle.cx, circles[0].cx);
    assert.equal(circle.cy, circles[0].cy);
    assert.equal(circle.r, circles[0].r);
    if (circle['stroke-dasharray']) {
      const dashes = circle['stroke-dasharray'].split(/[\s,]+/).map(Number);
      assert.equal(dashes.length, 2);
      assert.ok(dashes.every((length) => Number.isFinite(length) && length >= 0));
      assert.ok(Math.abs(dashes[0] + dashes[1] - 2 * Math.PI * Number(circle.r)) < 1e-8);
      assert.ok(Number.isFinite(Number(circle['stroke-dashoffset'] ?? 0)));
    }
  }
  return { html, circles };
}

const modulo = (value, period) => ((value % period) + period) % period;

// Resolve the actual SVG dash pattern and painter order at a point on the ring.
// The input fraction goes clockwise from 12 o'clock; unrotated circles begin at
// 3 o'clock. SVG adds dashoffset to the distance before choosing dash or gap.
function paintedColor(circles, clockwiseFraction) {
  let color;
  for (const circle of circles) {
    if (!circle['stroke-dasharray']) {
      color = circle.stroke;
      continue;
    }
    const [dash, gap] = circle['stroke-dasharray'].split(/[\s,]+/).map(Number);
    const rotation = circle.transform?.match(/^rotate\(\s*([-\d.]+)/);
    assert.ok(rotation, 'Completed arcs must expose their SVG rotation');
    const pathFraction = modulo(clockwiseFraction - 0.25 - Number(rotation[1]) / 360, 1);
    const distance = pathFraction * 2 * Math.PI * Number(circle.r);
    const phase = modulo(distance + Number(circle['stroke-dashoffset'] ?? 0), dash + gap);
    if (phase < dash) color = circle.stroke;
  }
  return color;
}

function expectedColor(segments, total, clockwiseFraction) {
  let end = 0;
  for (const segment of segments) {
    if (segment.value <= 0 || total <= 0) continue;
    end += segment.value / total;
    if (clockwiseFraction < end) return segment.color;
  }
  return PENDING;
}

function assertPaint(props) {
  const rendered = renderChart(props);
  // Sample around the entire circumference, including tiny 1% slices and the
  // pending interval. This catches misplaced slices and later grey overpainting.
  const samples = 12000;
  for (let index = 0; index < samples; index += 1) {
    const fraction = (index + 0.5) / samples;
    assert.equal(
      paintedColor(rendered.circles, fraction),
      expectedColor(props.segments, props.total, fraction),
      `Wrong painted color at ${(fraction * 100).toFixed(4)}% clockwise from 12 o'clock`,
    );
  }
  // Every positive segment must be painted in its own color at its midpoint,
  // even when it occupies less than one percent of the ring.
  let start = 0;
  for (const segment of props.segments) {
    if (segment.value <= 0 || props.total <= 0) continue;
    const fraction = segment.value / props.total;
    assert.equal(paintedColor(rendered.circles, start + fraction / 2), segment.color);
    start += fraction;
  }
  const checked = props.centerChecked ?? (props.total - props.pending);
  const percentage = props.total > 0 ? Math.round(checked / props.total * 100) : 0;
  assert.match(rendered.html, new RegExp(`>${percentage}%</text>`));
  assert.match(rendered.html, new RegExp(`>${checked}/${props.total}</text>`));
  return rendered;
}

for (const percentage of [0, 1, 2, 3, 50, 51, 52, 53, 54, 55, 99, 100]) {
  const total = 10000;
  const completed = percentage * total / 100;
  test(`Single-segment donut paints ${percentage}% contiguously from 12 o'clock`, () => {
    assertPaint({ segments: [{ value: completed, color: BLUE }], pending: total - completed, total });
  });
  test(`Multiple-segment donut paints ${percentage}% with matching colors and pending coverage`, () => {
    assertPaint({ segments: [
      { value: completed * 0.8, color: BLUE },
      { value: completed * 0.15, color: ORANGE },
      { value: completed * 0.05, color: GREEN },
    ], pending: total - completed, total });
  });
}

test('Pre-Route screenshot paints 78 blue vehicles and one orange Van out of 117', () => {
  const rendered = assertPaint({ segments: [
    { value: 78, color: BLUE }, { value: 1, color: ORANGE },
    { value: 0, color: GREEN },
  ], pending: 38, total: 117 });
  assert.match(rendered.html, />68%<\/text>/);
  assert.equal(paintedColor(rendered.circles, 0.5), BLUE, 'The arc must continue through 6 o\'clock');
  assert.equal(paintedColor(rendered.circles, 78.5 / 117), ORANGE, 'Van must keep its legend color');
  assert.equal(paintedColor(rendered.circles, 0.9), PENDING);
});

test('Post-Route screenshot paints a visible 3/117 blue sliver', () => {
  const rendered = assertPaint({ segments: [
    { value: 3, color: BLUE }, { value: 0, color: ORANGE },
  ], pending: 114, total: 117 });
  assert.match(rendered.html, />3%<\/text>/);
  assert.equal(paintedColor(rendered.circles, 1 / 117), BLUE);
  assert.equal(paintedColor(rendered.circles, 4 / 117), PENDING);
});

test('A zero-total donut remains entirely pending without invalid SVG numbers', () => {
  const rendered = assertPaint({ segments: [
    { value: 0, color: BLUE }, { value: 0, color: ORANGE },
  ], pending: 0, total: 0 });
  assert.equal(rendered.circles.length, 1);
  assert.doesNotMatch(rendered.html, /NaN|Infinity/);
});

test('Composition donuts keep every segment while centerChecked overrides the label', () => {
  const rendered = assertPaint({ segments: [
    { value: 139, color: BLUE }, { value: 41, color: ORANGE },
    { value: 53, color: GREEN },
  ], pending: 0, total: 233, centerChecked: 117 });
  assert.match(rendered.html, />50%<\/text>/);
  for (const fraction of [0.01, 0.6, 0.99]) {
    assert.notEqual(paintedColor(rendered.circles, fraction), PENDING);
  }
});
