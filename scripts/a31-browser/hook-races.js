async (page) => {
  await page.goto('http://127.0.0.1:5174/tests/polling-harness.html');
  await page.waitForFunction(() => !!window.runPollingTests);
  return await page.evaluate(() => window.runPollingTests());
}
