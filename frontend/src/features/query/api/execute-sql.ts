import { invoke } from '@tauri-apps/api/core';
import { QueryResult } from '../types';

export const executeSql = async (filePath: string, query: string): Promise<QueryResult> => {
    return await invoke('execute_sql', { filePath, query });
};
