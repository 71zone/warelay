import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_GRID_ROWS, MAX_GRID_WIDTH, SMALL_TABLE_MAX_ROWS, isBigTable, tableToGrid } from '../src/core/table.js';

const rows = (count: number, cells = ['k', 'v']): string[][] => Array.from({ length: count }, (_, index) => [`r${index}`, ...cells.slice(1)]);

test('a table that fits the phone grid with at most 8 rows is small', () => {
  assert.equal(isBigTable(['Name', 'Qty'], [['Apple', '3'], ['Kiwi', '12']]), false);
  assert.equal(isBigTable(['k', 'v'], rows(SMALL_TABLE_MAX_ROWS)), false);
  assert.equal(isBigTable(['A', 'B'], []), false);
});

test('more than 8 rows makes a table big even when its grid would fit', () => {
  assert.ok(tableToGrid(['k', 'v'], rows(SMALL_TABLE_MAX_ROWS + 1)) !== null);
  assert.equal(isBigTable(['k', 'v'], rows(SMALL_TABLE_MAX_ROWS + 1)), true);
  assert.equal(isBigTable(['k', 'v'], rows(MAX_GRID_ROWS + 1)), true);
});

test('a table wider than the phone grid is big however few rows it has', () => {
  const header = ['Typical TL answer', 'Stronger Senior TL answer'];
  assert.equal(isBigTable(header, [['"I coached the underperforming agents."', '"I analyzed performance patterns before deciding on the intervention."']]), true);
  const exact = ['x'.repeat(MAX_GRID_WIDTH - 4), 'y'];
  assert.equal(isBigTable(['a', 'b'], [exact]), false);
  assert.equal(isBigTable(['a', 'b'], [['x'.repeat(MAX_GRID_WIDTH - 3), 'y']]), true);
});

test('a card of rows with no header text has a grid without header lines and sizes by its rows only', () => {
  assert.equal(tableToGrid([], [['S', 'Situation'], ['T', 'Task']]), 'S | Situation\nT | Task');
  assert.equal(isBigTable([], [['S', 'Situation — 15%\nWhat was the problem? Explain the operational context and its impact.']]), true);
});

test('cells that wrap onto several lines are measured as one line, like the grid renders them', () => {
  assert.equal(isBigTable(['a', 'b'], [['one\ntwo', 'three']]), false);
  assert.equal(isBigTable(['a', 'b'], [['x'.repeat(30), 'y'.repeat(30)]]), true);
});
