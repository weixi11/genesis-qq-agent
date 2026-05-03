declare module 'sql.js' {
    export interface Database {
        run(sql: string, params?: any[]): void;
        exec(sql: string): void;
        prepare(sql: string): Statement;
        export(): Uint8Array;
        close(): void;
        getRowsModified(): number;
    }

    export interface Statement {
        bind(params?: any[]): void;
        step(): boolean;
        get(): any[];
        getAsObject(): Record<string, any>;
        free(): void;
    }

    export interface SqlJsStatic {
        Database: new (data?: ArrayLike<number>) => Database;
    }

    export default function initSqlJs(): Promise<SqlJsStatic>;
}
