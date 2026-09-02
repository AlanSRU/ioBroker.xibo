import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        files: ['src/**/*.ts'],
        rules: {
            /*
             * This codebase documents *why* — the CMS quirk, the failure the
             * code exists to prevent — in prose above the declaration, rather
             * than as an @param list. `require-jsdoc` cannot see that, and its
             * autofix inserts an empty jsdoc block above declarations that
             * are already documented, which then trips `no-blank-blocks`:
             * 68 of them on this repo, plus 61 bare @param lines carrying no
             * description. Empty stubs above real comments are worse than no
             * stubs, so the rules are off and the prose stays.
             */
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-param': 'off',
            'jsdoc/require-returns-description': 'off',
        },
    },
    {
        // build/ is tsc output; admin/ is browser-side config served as-is;
        // the test suites are checked by tsc and run in CI rather than linted
        // against the adapter's own jsdoc rules.
        ignores: ['build/**', 'admin/**', 'test/**', 'node_modules/**', '.dev-server/**'],
    },
];
