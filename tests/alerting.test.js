'use strict';

const Alerting = require('../src/utils/alerting');

const CHANNEL = 'C_OPS';
const logger = { error: jest.fn() };

function makeClient() {
  return { chat: { postMessage: jest.fn().mockResolvedValue({}) } };
}

function makeAlerting(client, overrides = {}) {
  return new Alerting({
    client,
    channelId: CHANNEL,
    errorThreshold: 3,
    errorWindowMs: 5 * 60 * 1000,
    ...overrides,
  });
}

describe('Alerting', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does not alert below the error threshold', async () => {
    const client = makeClient();
    const alerting = makeAlerting(client);

    await alerting.recordError('my-workflow', 'HTTP 500', logger);
    await alerting.recordError('my-workflow', 'HTTP 500', logger);

    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  test('posts an alert when the threshold is reached', async () => {
    const client = makeClient();
    const alerting = makeAlerting(client);

    await alerting.recordError('my-workflow', 'err', logger);
    await alerting.recordError('my-workflow', 'err', logger);
    await alerting.recordError('my-workflow', 'err', logger); // 3rd = threshold

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: CHANNEL,
      text: expect.stringContaining('my-workflow'),
    }));
  });

  test('resets the error log after alerting to avoid flooding', async () => {
    const client = makeClient();
    const alerting = makeAlerting(client);

    for (let i = 0; i < 3; i++) await alerting.recordError('w', 'err', logger);
    for (let i = 0; i < 2; i++) await alerting.recordError('w', 'err', logger); // below threshold again

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1); // only one alert
  });

  test('different integrations are tracked independently', async () => {
    const client = makeClient();
    const alerting = makeAlerting(client);

    await alerting.recordError('wf-a', 'err', logger);
    await alerting.recordError('wf-a', 'err', logger);
    await alerting.recordError('wf-b', 'err', logger); // wf-b count = 1, should not trigger
    await alerting.recordError('wf-a', 'err', logger); // wf-a = 3, should trigger

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage.mock.calls[0][0].text).toContain('wf-a');
  });

  test('posts a rate limit notification', async () => {
    const client = makeClient();
    const alerting = makeAlerting(client);

    await alerting.recordRateLimit('my-workflow', 20, logger);

    expect(client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Rate limit'),
    }));
  });

  test('does not throw if posting the alert fails', async () => {
    const client = { chat: { postMessage: jest.fn().mockRejectedValue(new Error('Slack down')) } };
    const alerting = makeAlerting(client);

    await expect(
      Promise.all([
        alerting.recordError('w', 'e', logger),
        alerting.recordError('w', 'e', logger),
        alerting.recordError('w', 'e', logger),
      ])
    ).resolves.not.toThrow();
  });
});
