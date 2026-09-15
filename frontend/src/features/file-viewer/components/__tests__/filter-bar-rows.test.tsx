import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FilterBar } from '../filter-bar';
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

  it('keeps one empty row when the last one goes, and clears the filter', () => {
    const onFilterChange = renderBar();
    fireEvent.change(valueInputs()[0], { target: { value: '5' } });

    fireEvent.click(removeButtons()[0]);
    expect(valueInputs()).toHaveLength(1);
    expect(valueInputs()[0]).toHaveValue('');
    expect(onFilterChange).toHaveBeenCalledWith('');
  });
});
