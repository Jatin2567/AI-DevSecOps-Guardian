const issueService = require('../services/issueService');
const gitlabService = require('../services/gitlabService');

// mock gitlab service
jest.mock('../services/gitlabService', () => ({
  createIssue: jest.fn().mockResolvedValue({ iid: 42, title: '[AUTO] test issue' })
}));

describe('issueService.createIssueFromAnalysis', () => {
  test('should call gitlabService.createIssue', async () => {
    const analysis = {
      stage: 'build',
      root_cause: 'missing package',
      suggested_fix: 'install dependency',
      confidence: 0.9
    };

    const job = { name: 'build-job' };
    const result = await issueService.createIssueFromAnalysis(123, {
      pipelineId: 1,
      job,
      analysis
    });

    expect(gitlabService.createIssue).toHaveBeenCalled();
    expect(result.iid).toBe(42);
  });
});
