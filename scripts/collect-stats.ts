import { Octokit } from '@octokit/core';
import type { Endpoints } from '@octokit/types';
import { writeFile } from 'node:fs/promises';
import pRetry from 'p-retry';
import type { Contributor } from './types';

type APIData<T extends keyof Endpoints> = Endpoints[T]['response']['data'];
type Repo = APIData<'GET /orgs/{org}/repos'>[number];
type CustomCategories = {
  [key: string]: {
    [key: string]: string[]
  },
}
interface AugmentedRepo extends Repo {
  reviews: APIData<'GET /repos/{owner}/{repo}/pulls/comments'>;
  issues: APIData<'GET /repos/{owner}/{repo}/issues'>;
  commits: APIData<'GET /repos/{owner}/{repo}/commits'>;
}

const retry: typeof pRetry = (fn, opts) =>
  pRetry(fn, {
    onFailedAttempt: (e) =>
      console.log(
        `Attempt ${e.attemptNumber} failed. There are ${e.retriesLeft} retries left.\n `,
        e.message
      ),
    ...opts,
  });

class StatsCollector {
  #org: string;
  #app: Octokit;

  constructor(opts: { org: string; token: string | undefined }) {
    this.#org = opts.org;
    this.#app = new Octokit({ auth: opts.token });
  }

  async run() {
    const repos = await this.#getReposWithExtraStats();

    const contributors: Record<string, Contributor> = {};

    console.log('Processing data...');
    for (const repo of repos) {
      for (const issue of repo.issues) {
        const { user, pull_request, labels } = issue;
        if (!user) {
          console.warn(`No user found for ${repo.full_name}#${issue.number}`);
          continue;
        }
        const { avatar_url, login } = user;
        const contributor =
          contributors[login] =
            contributors[login] || this.#newContributor({ avatar_url });
        if (pull_request) {
          contributor.pulls[repo.name] =
            (contributor.pulls[repo.name] || 0) + 1;
          if (pull_request.merged_at) {
            contributor.merged_pulls[repo.name] =
              (contributor.merged_pulls[repo.name] || 0) + 1;
          }
        } else {
          contributor.issues[repo.name] =
            (contributor.issues[repo.name] || 0) + 1;
        }
      }

      /** Temporary store for deduplicating multiple reviews on the same PR. */
      const reviewedPRs: Record<string, Set<string>> = {};

      for (const review of repo.reviews) {
        const { user, pull_request_url, path } = review;
        if (!user) {
          console.warn(`No user found for PR review: ${review.url}`);
          continue;
        }
        const { avatar_url, login } = user;
        const contributor =
          contributors[login] =
            contributors[login] || this.#newContributor({ avatar_url });
        const contributorReviews =
          reviewedPRs[login] = reviewedPRs[login] || new Set();
        if (!contributorReviews.has(pull_request_url)) {
          contributor.reviews[repo.name] =
            (contributor.reviews[repo.name] || 0) + 1;
          contributorReviews.add(pull_request_url);
        }
      }
      
      for (const commit of repo.commits) {
        const { author, committer } = commit;
        const user = author || committer;
        if (!user) {
          console.warn(`No user found for commit: ${commit.url}`);
          continue;
        }
        const { avatar_url, login } = user;
        const contributor =
          contributors[login] =
            contributors[login] || this.#newContributor({ avatar_url });
        contributor.commits[repo.name] =
          (contributor.commits[repo.name] || 0) + 1;
      }
    }
    console.log('Done processing data!');

    console.log('Writing to disk...');
    await this.#writeData(contributors);
    console.log('Mission complete!');
  }

  #newContributor({ avatar_url }: { avatar_url: string }): Contributor {
    return { avatar_url, issues: {}, pulls: {}, merged_pulls: {}, commits: {}, reviews: {} };
  }

  async #getRepos() {
    const request = () =>
      this.#app.request(`GET /orgs/{org}/repos`, {
        org: this.#org,
        type: 'sources',
      });
    return (await retry(request)).data.filter((repo) => !repo.private);
  }

  async #getAllIssues(repo: string, page = 1) {
    if (page === 1) console.log(`Fetching issues for ${this.#org}/${repo}...`);
    const per_page = 100;

    const { data: issues, headers } = await retry(() =>
      this.#app.request('GET /repos/{owner}/{repo}/issues', {
        owner: this.#org,
        repo,
        page,
        per_page,
        state: 'all',
      })
    );

    if (headers.link?.includes('rel="next"')) {
      const nextPage = await this.#getAllIssues(repo, page + 1);
      issues.push(...nextPage);
    }

    if (page === 1)
      console.log(
        `Done fetching ${issues.length} issues for ${this.#org}/${repo}`
      );
    return issues;
  }

  async #getAllReviews(repo: string, page = 1) {
    if (page === 1)
      console.log(`Fetching PR reviews for ${this.#org}/${repo}...`);
    const per_page = 100;

    const { data: reviews, headers } = await retry(() =>
      this.#app.request('GET /repos/{owner}/{repo}/pulls/comments', {
        owner: this.#org,
        repo,
        page,
        per_page,
      })
    );

    if (headers.link?.includes('rel="next"')) {
      const nextPage = await this.#getAllReviews(repo, page + 1);
      reviews.push(...nextPage);
    }

    if (page === 1)
      console.log(
        `Done fetching ${reviews.length} PR reviews for ${this.#org}/${repo}`
      );
    return reviews;
  }

  async #getAllCommits(repo: string, page = 1) {
    if (page === 1) console.log(`Fetching commits for ${this.#org}/${repo}...`);
    const per_page = 100;

    const { data: commits, headers } = await retry(() =>
      this.#app.request('GET /repos/{owner}/{repo}/commits', {
        owner: this.#org,
        repo,
        page,
        per_page,
      })
    );

    if (headers.link?.includes('rel="next"')) {
      const nextPage = await this.#getAllCommits(repo, page + 1);
      commits.push(...nextPage);
    }

    if (page === 1)
      console.log(
        `Done fetching ${commits.length} commits for ${this.#org}/${repo}`
      );
    return commits;
  }

  async #getReposWithExtraStats() {
    console.log('Fetching repos...');
    const repos = await this.#getRepos();
    console.log('Done fetching repos!');
    const reposWithStats: AugmentedRepo[] = [];
    for (const repo of repos) {
      reposWithStats.push({
        ...repo,
        issues: await this.#getAllIssues(repo.name),
        reviews: await this.#getAllReviews(repo.name),
        commits: await this.#getAllCommits(repo.name),
      });
    }
    return reposWithStats;
  }

  async #writeData(data: any) {
    return await writeData(data);
  }
}

const collector = new StatsCollector({
  org: 'Unofficial-BlossomCraft-Wikis',
  token: process.env.GITHUB_TOKEN,
});
await collector.run();

async function writeData(data: any) {
  const filePaths = [
    'published/contributors.json',
  ];

  // Iterate over each file path and write the data asynchronously
  await Promise.all(filePaths.map(async (filePath) => {
    await writeFile(filePath, JSON.stringify(data), 'utf8');
    console.log(`Data written to ${filePath}`);
  }));
}