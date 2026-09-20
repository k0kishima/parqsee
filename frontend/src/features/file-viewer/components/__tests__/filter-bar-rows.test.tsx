import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { createRef } from 'react';
import { FilterBar, type FilterBarHandle } from '../filter-bar';
import type { ColumnInfo } from '../../api';

const columns: ColumnInfo[] = [
  { name: 'id', column_type: 'INT64', kind: 'integer', logical_type: null, physical_type: 'INT64' },
  { name: 'name', column_type: 'STRING', kind: 'text', logical_type: null, physical_type: 'STRING' },
];

// The mocked `t` answers with the key, so the buttons are named by it.
const addButton = () => screen.getByRole('button', { name: 'common.addCondition' });
const removeButtons = () => screen.getAllByRole('button', { name: 'common.removeCondition' });
const valueInputs = () => screen.getAllByRole('textbox');
// Two selects per row: the column, then the operator.
const columnSelects = () => screen.getAllByRole('combobox').filter((_, i) => i % 2 === 0);

function renderBar() {
  const onFilterChange = vi.fn();
  render(<FilterBar columns={columns} onFilterChange={onFilterChange} activeFilter="" />);
  return onFilterChange;
}

describe('FilterBar rows', () => {
  it('starts with one condition and adds one behind it', () => {
    renderBar();
    expect(removeButtons()).toHaveLength(1);
    fireEvent.click(addButton());
    expect(removeButtons()).toHaveLength(2);
  });

  it('starts with no column picked, so an untouched bar states no condition', () => {
    const onFilterChange = renderBar();
    expect(columnSelects()[0]).toHaveValue('');
    expect(screen.getByRole('option', { name: 'viewer.filterColumnPlaceholder' })).toBeInTheDocument();

    // A value typed without picking a column applies nothing rather than
    // filtering on whichever column the file happens to begin with.
    fireEvent.change(valueInputs()[0], { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.apply' }));
    expect(onFilterChange).toHaveBeenCalledWith('');

    fireEvent.change(columnSelects()[0], { target: { value: 'id' } });
    // The placeholder leaves the list once a column is picked.
    expect(screen.queryByRole('option', { name: 'viewer.filterColumnPlaceholder' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.apply' }));
    expect(onFilterChange).toHaveBeenLastCalledWith('"id" = 5');
  });

  it('empties a row whose column the new columns no longer have', () => {
    const onFilterChange = vi.fn();
    const { rerender } = render(<FilterBar columns={columns} onFilterChange={onFilterChange} activeFilter="" />);
    fireEvent.change(columnSelects()[0], { target: { value: 'name' } });
    fireEvent.change(valueInputs()[0], { target: { value: 'JP' } });

    rerender(<FilterBar columns={[columns[0]]} onFilterChange={onFilterChange} activeFilter="" />);

    // Not moved to the first column, which would read the value against a
    // column nobody chose.
    expect(columnSelects()[0]).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'common.apply' }));
    expect(onFilterChange).toHaveBeenLastCalledWith('');
  });

  it('removes only the row whose − was pressed', () => {
    renderBar();
    fireEvent.click(addButton());
    fireEvent.change(valueInputs()[1], { target: { value: 'kept' } });

    fireEvent.click(removeButtons()[0]);
    expect(valueInputs()).toHaveLength(1);
    expect(valueInputs()[0]).toHaveValue('kept');
  });

  it('tells rows added within one millisecond apart', () => {
    // A frozen clock: ids taken from Date.now() would all be the same.
    vi.useFakeTimers();
    try {
      renderBar();
      fireEvent.click(addButton());
      fireEvent.click(addButton());
      expect(removeButtons()).toHaveLength(3);

      fireEvent.click(removeButtons()[1]);
      expect(removeButtons()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one empty row when the last one goes, and clears the filter', () => {
    const onFilterChange = renderBar();
    fireEvent.change(valueInputs()[0], { target: { value: '5' } });

    fireEvent.click(removeButtons()[0]);
    expect(valueInputs()).toHaveLength(1);
    expect(valueInputs()[0]).toHaveValue('');
    expect(onFilterChange).toHaveBeenCalledWith('');
  });

  describe('addConditions from outside the form', () => {
    it('restores editable rows when metadata arrives after mount', () => {
      const onFilterChange = vi.fn();
      const ref = createRef<FilterBarHandle>();
      const activeFilter = `"name" IS NOT NULL AND "id" >= 0`;
      const { rerender } = render(<FilterBar ref={ref} columns={[]} onFilterChange={onFilterChange} activeFilter={activeFilter} />);
      rerender(<FilterBar ref={ref} columns={columns} onFilterChange={onFilterChange} activeFilter={activeFilter} />);
      expect(valueInputs()).toHaveLength(2);
      act(() => ref.current!.addConditions([{ column: 'id', operator: '>=', value: '20' }]));
      expect(onFilterChange).toHaveBeenLastCalledWith(`"name" IS NOT NULL AND "id" >= 20`);
    });
    function renderWithHandle(activeFilter = '', cols = columns) {
      const onFilterChange = vi.fn();
      const ref = createRef<FilterBarHandle>();
      const view = render(<FilterBar ref={ref} columns={cols} onFilterChange={onFilterChange} activeFilter={activeFilter} />);
      // The handle is called from outside React's own event handling, so
      // the state it sets is flushed under act() as an event would be.
      const add = (conditions: Parameters<FilterBarHandle['addConditions']>[0]) =>
        act(() => ref.current!.addConditions(conditions));
      return { onFilterChange, add, rerenderFilter: (filter: string) => view.rerender(
        <FilterBar ref={ref} columns={cols} onFilterChange={onFilterChange} activeFilter={filter} />
      ) };
    }

    it('preserves restored conditions and replaces restored range operators', () => {
      const { onFilterChange, add } = renderWithHandle(`"name" = 'JP' AND "id" >= 0 AND "id" < 100`);
      expect(valueInputs()).toHaveLength(3);
      add([{ column: 'id', operator: '>=', value: '20' }, { column: 'id', operator: '<', value: '40' }]);
      expect(onFilterChange).toHaveBeenLastCalledWith(`"name" = 'JP' AND "id" >= 20 AND "id" < 40`);
    });

    it('preserves quotes and AND inside restored text literals', () => {
      const { onFilterChange, add } = renderWithHandle(`"name" = 'a AND b''s'`);
      add([{ column: 'id', operator: '=', value: '5' }]);
      expect(onFilterChange).toHaveBeenLastCalledWith(`"name" = 'a AND b''s' AND "id" = 5`);
    });

    it('keeps opaque predicates parenthesized and visible', () => {
      const base = `"id" = 1 OR "id" = 2`;
      const { onFilterChange, add } = renderWithHandle(base);
      expect(screen.getByText(base)).toBeInTheDocument();
      add([{ column: 'name', operator: '=', value: 'JP' }]);
      expect(onFilterChange).toHaveBeenLastCalledWith(`(${base}) AND "name" = 'JP'`);
    });

    it('uses the rolled-back filter after a failed submission', () => {
      const { onFilterChange, add, rerenderFilter } = renderWithHandle(`"id" = 1`);
      add([{ column: 'name', operator: '=', value: 'JP' }]);
      rerenderFilter(`"id" = 1 AND "name" = 'JP'`);
      rerenderFilter(`"id" = 1`);
      add([{ column: 'id', operator: '>=', value: '0' }]);
      expect(onFilterChange).toHaveBeenLastCalledWith(`"id" = 1 AND "id" >= 0`);
    });

    it.each(['', '   '])('keeps an explicit text value %j through Apply and restore', value => {
      const { onFilterChange, add } = renderWithHandle();
      add([{ column: 'name', operator: '=', value }]);
      const expected = `"name" = '${value}'`;
      expect(onFilterChange).toHaveBeenLastCalledWith(expected);
      fireEvent.click(screen.getByRole('button', { name: 'common.apply' }));
      expect(onFilterChange).toHaveBeenLastCalledWith(expected);
    });

    it('restores an empty binary value and keeps it on another profile click', () => {
      const cols: ColumnInfo[] = [...columns, { ...columns[1], name: 'bin', kind: 'binary' }];
      const { onFilterChange, add } = renderWithHandle(`encode(CAST("bin" AS BYTEA), 'hex') = ''`, cols);
      expect(valueInputs()).toHaveLength(1);
      add([{ column: 'id', operator: '=', value: '5' }]);
      expect(onFilterChange).toHaveBeenLastCalledWith(`encode(CAST("bin" AS BYTEA), 'hex') = '' AND "id" = 5`);
    });

    it('lights the rows it added and focuses the first, until the animation ends', () => {
      const { add } = renderWithHandle();
      add([
        { column: 'id', operator: '>=', value: '0' },
        { column: 'id', operator: '<', value: '50' },
      ]);

      const inputs = valueInputs();
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toHaveFocus();
      inputs.forEach(input => expect(input).toHaveClass('filter-arrived'));
      // Every control of the row is lit, not only the value.
      expect(screen.getAllByRole('combobox').filter(c => c.classList.contains('filter-arrived'))).toHaveLength(4);

      fireEvent.animationEnd(inputs[0]);
      expect(inputs[0]).not.toHaveClass('filter-arrived');
      expect(inputs[1]).toHaveClass('filter-arrived');
    });

    it('focuses the operator of a row whose operator takes no value', () => {
      const { add } = renderWithHandle();
      add([{ column: 'name', operator: 'IS NULL', value: '' }]);
      expect(screen.getAllByRole('combobox')[1]).toHaveFocus();
      expect(screen.getAllByRole('combobox')[1]).toHaveValue('IS NULL');
    });

    it('takes the place of the blank row and applies at once', () => {
      const { onFilterChange, add } = renderWithHandle();
      add([{ column: 'name', operator: '=', value: 'a' }]);

      expect(onFilterChange).toHaveBeenCalledWith(`"name" = 'a'`);
      expect(valueInputs()).toHaveLength(1);
      expect(valueInputs()[0]).toHaveValue('a');
    });

    it('keeps a filled-in row and adds behind it', () => {
      const { onFilterChange, add } = renderWithHandle();
      fireEvent.change(columnSelects()[0], { target: { value: 'id' } });
      fireEvent.change(valueInputs()[0], { target: { value: '5' } });
      add([
        { column: 'name', operator: '>=', value: 'a' },
        { column: 'name', operator: '<', value: 'm' },
      ]);

      expect(onFilterChange).toHaveBeenCalledWith(`"id" = 5 AND "name" >= 'a' AND "name" < 'm'`);
      expect(valueInputs()).toHaveLength(3);
    });

    it('replaces a row on the same column with the same operator, so a narrower range does not stack', () => {
      const { onFilterChange, add } = renderWithHandle();
      add([
        { column: 'id', operator: '>=', value: '0' },
        { column: 'id', operator: '<', value: '100' },
      ]);
      add([
        { column: 'id', operator: '>=', value: '20' },
        { column: 'id', operator: '<', value: '40' },
      ]);

      expect(onFilterChange).toHaveBeenLastCalledWith(`"id" >= 20 AND "id" < 40`);
      expect(valueInputs()).toHaveLength(2);
    });

    it('replaces an inclusive upper bound with an exclusive one and vice versa', () => {
      const { onFilterChange, add } = renderWithHandle();
      for (const operator of ['<', '<=', '<'] as const) {
        add([{ column: 'id', operator, value: '40' }]);
        expect(onFilterChange).toHaveBeenLastCalledWith(`"id" ${operator} 40`);
        expect(valueInputs()).toHaveLength(1);
      }
    });

    it('restores a NaN predicate as an editable and replaceable condition', () => {
      const { onFilterChange, add } = renderWithHandle('isnan(CAST("id" AS DOUBLE))', [{ ...columns[0], kind: 'float' }]);
      expect(valueInputs()[0]).toHaveValue('NaN');
      add([{ column: 'id', operator: '=', value: '5' }]);
      expect(onFilterChange).toHaveBeenLastCalledWith('"id" = 5');
    });

    it.each(['NaN', 'Infinity', '-Infinity'])('accepts the explicit float value %s from a chart', value => {
      const { onFilterChange, add } = renderWithHandle('', [{ ...columns[0], kind: 'float' }]);
      add([{ column: 'id', operator: '=', value }]);
      expect(onFilterChange).toHaveBeenLastCalledWith(value === 'NaN' ? 'isnan(CAST("id" AS DOUBLE))' : `"id" = '${value}'`);
    });
  });
});
