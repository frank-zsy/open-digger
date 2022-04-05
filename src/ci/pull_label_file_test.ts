import { existsSync, readFileSync } from 'fs';
import { EOL } from 'os';
import { load } from 'js-yaml';
import { getGitHubClient, requestPullFile } from './utils';

(async () => {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) {
    console.log(`Not in GitHub actions env or event file not found at path=${eventPath}.`);
    return;
  }

  const event = JSON.parse(readFileSync(eventPath).toString());

  if (!event?.number || !event?.pull_request) {
    console.log(`Event not currect, need event to be in pull request, event=${event}`);
    return;
  }

  const pullNumber = event.number;
  const owner = event.repository.owner.login;
  const repo = event.repository.name;

  const octokit = await getGitHubClient();

  try {
    const pullDetail = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner,
      repo,
      pull_number: pullNumber,
    });
    const changedLabelFiles = pullDetail.data.filter(f => f.filename.startsWith('labeled_data/') && f.filename.endsWith('.yml'));
    if (changedLabelFiles.length === 0) {
      console.log('No label files changed in this pr');
      return;
    }

    let comment = `I found ${changedLabelFiles.length} label files. The contents are parsed as below:${EOL}`;
    for (const f of changedLabelFiles) {
      try {
        const content = await requestPullFile(f.raw_url);
        const json = load(content, { json: true });
        comment += `- ${f.filename}, parsed result is:${EOL}\`\`\` json${JSON.stringify(json)}${EOL}\`\`\`${EOL}`;
      } catch {
        comment = 'Parse YAML file format error, please check the file content';
      }
    }
    
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner,
      repo,
      issue_number: pullNumber,
      body: comment,
    });
  } catch (e) {
    console.log(`Request pull detail error, err=${e}`);
  }

})();
