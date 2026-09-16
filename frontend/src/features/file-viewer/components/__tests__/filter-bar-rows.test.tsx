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
    function renderWithHandle() {
      const onFilterChange = vi.fn();
      const ref = createRef<FilterBarHandle>();
      render(<FilterBar ref={ref} columns={columns} onFilterChange={onFilterChange} activeFilter="" />);
      // The handle is called from outside React's own event handling, so
      // the state it sets is flushed under act() as an event would be.
      const add = (conditions: Parameters<FilterBarHandle['addConditions']>[0]) =>
        act(() => ref.current!.addConditions(conditions));
      return { onFilterChange, add };
    }

    it('takes the place of the blank row and applies at once', () => {
      const { onFilterChange, add } = renderWithHandle();
      add([{ column: 'name', operator: '=', value: 'a' }]);

      expect(onFilterChange).toHaveBeenCalledWith(`"name" = 'a'`);
      expect(valueInputs()).toHaveLength(1);
      expect(valueInputs()[0]).toHaveValue('a');
    });

    it('keeps a filled-in row and adds behind it', () => {
      const { onFilterChange, add } = renderWithHandle();
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
  });
});
