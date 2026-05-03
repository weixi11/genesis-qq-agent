/**
 * Genesis ESLint 配置
 * 基于 CODING_STANDARDS.md 开发规范
 * 使用 ESLint v9 Flat Config 格式
 */

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    // 全局忽略 - 必须放在最前面
    {
        ignores: [
            'dist/**',
            'node_modules/**',
            '**/*.js',
            '**/*.cjs',
            '**/*.mjs',
            'src/web/public/**',  // 忽略前端 JS 文件
        ],
    },

    // 基础配置 - 只应用于 TS 文件
    {
        files: ['src/**/*.ts'],
        extends: [
            eslint.configs.recommended,
            ...tseslint.configs.recommendedTypeChecked,
        ],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.es2022,
            },
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            // ===== 零容忍规则 (暂时 warn，待存量代码修复后改为 error) =====

            // 禁止 any 类型
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unsafe-assignment': 'warn',
            '@typescript-eslint/no-unsafe-member-access': 'warn',
            '@typescript-eslint/no-unsafe-call': 'warn',
            '@typescript-eslint/no-unsafe-return': 'warn',
            '@typescript-eslint/no-unsafe-argument': 'warn',

            // 强制显式返回类型
            // 强制显式返回类型
            '@typescript-eslint/explicit-function-return-type': 'off',

            // ===== 代码风格 =====

            // 函数复杂度
            // 函数复杂度
            'complexity': 'off',
            'max-lines-per-function': 'off',
            'max-depth': ['warn', { max: 4 }],

            // ===== 最佳实践 =====

            // 禁止未使用的变量
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],

            // 必须处理 Promise
            '@typescript-eslint/no-floating-promises': 'error',

            // 禁止非空断言
            '@typescript-eslint/no-non-null-assertion': 'warn',

            // 优先使用 nullish coalescing
            '@typescript-eslint/prefer-nullish-coalescing': 'off',

            // 优先使用 optional chaining
            '@typescript-eslint/prefer-optional-chain': 'warn',

            // 禁止 require
            '@typescript-eslint/no-require-imports': 'error',

            // 一致的类型导入
            '@typescript-eslint/consistent-type-imports': ['error', {
                prefer: 'type-imports',
                disallowTypeAnnotations: false,
            }],

            // ===== 基础规则 =====

            // 使用 === 而不是 ==
            'eqeqeq': ['error', 'always', { null: 'ignore' }],

            // 禁止 console（允许 warn 和 error）
            'no-console': 'off',

            // 禁止 debugger
            'no-debugger': 'error',

            // 禁止 eval
            'no-eval': 'error',

            // 禁止 with
            'no-with': 'error',
        },
    },
);
