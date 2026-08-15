/** Pin the backend the suite resolves to, so URL assertions don't depend on
 *  the developer's shell. Mirrors the Python SDK's autouse ``COSMO_BASE_URL``
 *  fixture in ``tests/conftest.py``. Tests that exercise resolution itself
 *  (``src/core/__tests__/base_url.test.ts``) clear it explicitly. */
process.env.COSMO_BASE_URL = 'https://api.example.com';
