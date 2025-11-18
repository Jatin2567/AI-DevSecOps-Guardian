const { sanitize } = require('../utils/logParser');

describe('logParser.sanitize', () => {
  test('should redact AWS keys', () => {
    const raw = 'Deploy failed AWS key AKIA1234567890ABCDEF used';
    const out = sanitize(raw);
    expect(out).not.toMatch(/AKIA/);
  });

  test('should truncate large logs', () => {
    const big = 'A'.repeat(10000);
    const out = sanitize(big);
    expect(out.length).toBeLessThan(6500); // after truncation
  });
});
