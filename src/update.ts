import slugify from "@sindresorhus/slugify";
import dayjs from "dayjs";
import { mkdirp, readFile, writeFile } from "fs-extra";
import { load } from "js-yaml";
import { join } from "path";
import { getConfig } from "./helpers/config";
import { commit, lastCommit, push } from "./helpers/git";
import { getOctokit } from "./helpers/github";
import { shouldContinue } from "./helpers/init-check";
import { sendNotification } from "./helpers/notifme";
import { getOwnerRepo } from "./helpers/secrets";
import { SiteCurrentStatus, SiteHistory } from "./interfaces";
import { generateSummary } from "./summary";
import curl from './checks/curl';
import websocket from './checks/websocket';
import tcpPing from './checks/tcp-ping';

export const update = async (shouldCommit = false) => {
  if (!(await shouldContinue())) return;
  await mkdirp("history");
  const [owner, repo] = getOwnerRepo();

  const config = await getConfig();
  const octokit = await getOctokit();

  let hasDelta = false;

  const _ongoingMaintenanceEvents = await octokit.issues.listForRepo({
    owner,
    repo,
    state: "open",
    filter: "all",
    sort: "created",
    direction: "desc",
    labels: "maintenance",
  });
  console.log("Found ongoing maintenance events", _ongoingMaintenanceEvents.data.length);
  const ongoingMaintenanceEvents: {
    issueNumber: number;
    metadata: { start: string; end: string; expectedDown: string[]; expectedDegraded: string[] };
  }[] = [];
  for await (const incident of _ongoingMaintenanceEvents.data) {
    const metadata: Record<string, string> = {};
    if (incident.body && incident.body.includes("<!--")) {
      const summary = incident.body.split("<!--")[1].split("-->")[0];
      const lines = summary
        .split("\n")
        .filter((i) => i.trim())
        .filter((i) => i.includes(":"));
      lines.forEach((i) => {
        metadata[i.split(/:(.+)/)[0].trim()] = i.split(/:(.+)/)[1].trim();
      });
    }
    if (metadata.start && metadata.end) {
      let expectedDown: string[] = [];
      let expectedDegraded: string[] = [];
      if (metadata.expectedDown)
        expectedDown = metadata.expectedDown
          .split(",")
          .map((i) => i.trim())
          .filter((i) => i.length);
      if (metadata.expectedDown)
        expectedDegraded = metadata.expectedDown
          .split(",")
          .map((i) => i.trim())
          .filter((i) => i.length);

      if (dayjs(metadata.end).isBefore(dayjs())) {
        await octokit.issues.update({
          owner,
          repo,
          issue_number: incident.number,
          state: "closed",
        });
        console.log("Closed maintenance completed event", incident.number);
      } else
        ongoingMaintenanceEvents.push({
          issueNumber: incident.number,
          metadata: { start: metadata.start, end: metadata.end, expectedDegraded, expectedDown },
        });
    }
  }

  for await (const site of config.sites) {
    console.log("Checking", site.url);

    const slug = site.slug || slugify(site.name);
    let currentStatus = "unknown";
    let startTime = new Date();
    try {
      const siteHistory = load(
        (await readFile(join(".", "history", `${slug}.yml`), "utf8"))
          .split("\n")
          .map((line) => (line.startsWith("- ") ? line.replace("- ", "") : line))
          .join("\n")
      ) as SiteHistory;
      currentStatus = siteHistory.status || "unknown";
      startTime = new Date(siteHistory.startTime || new Date());
    } catch (error) {}
    console.log("Current status", site.slug, currentStatus, startTime);

    /**
     * Check whether the site is online
     */
    const performTestOnce = async (): Promise<{
      result: {
        httpCode: number;
      };
      responseTime: string;
      status: SiteCurrentStatus;
    }> => {
      const checks = {
        "tcp-ping": tcpPing,
        "ws": websocket,
        "http": curl,
      }
      if (site.check && checks[site.check]) {
        return checks[site.check](site);
      }
      return checks["http"](site);
    };

    let { result, responseTime, status } = await performTestOnce();
    /**
     * If the site is down, we perform the test 2 more times to make
     * sure that it's not a false alarm
     */
    if (status === "down" || status === "degraded") {
      wait(1000);
      const secondTry = await performTestOnce();
      if (secondTry.status === "up") {
        result = secondTry.result;
        responseTime = secondTry.responseTime;
        status = secondTry.status;
      } else {
        wait(10000);
        const thirdTry = await performTestOnce();
        if (thirdTry.status === "up") {
          result = thirdTry.result;
          responseTime = thirdTry.responseTime;
          status = thirdTry.status;
        }
      }
    }

    try {
      if (shouldCommit || currentStatus !== status) {
        await writeFile(
          join(".", "history", `${slug}.yml`),
          `url: ${site.url}
status: ${status}
code: ${result.httpCode}
responseTime: ${responseTime}
lastUpdated: ${new Date().toISOString()}
startTime: ${startTime}
generator: Upptime <https://github.com/upptime/upptime>
`
        );
        commit(
          (
            (config.commitMessages || {}).statusChange ||
            "$PREFIX $SITE_NAME is $STATUS ($RESPONSE_CODE in $RESPONSE_TIME ms) [skip ci] [upptime]"
          )
            .replace(
              "$PREFIX",
              status === "up"
                ? config.commitPrefixStatusUp || "🟩"
                : status === "degraded"
                ? config.commitPrefixStatusDegraded || "🟨"
                : config.commitPrefixStatusDown || "🟥"
            )
            .replace("$SITE_NAME", site.name)
            .replace("$SITE_URL", site.url)
            .replace("$SITE_METHOD", site.method || "GET")
            .replace("$STATUS", status)
            .replace("$RESPONSE_CODE", result.httpCode.toString())
            .replace("$RESPONSE_TIME", responseTime),
          (config.commitMessages || {}).commitAuthorName,
          (config.commitMessages || {}).commitAuthorEmail
        );
        const lastCommitSha = lastCommit();

        if (currentStatus !== status) {
          console.log("Status is different", currentStatus, "to", status);
          hasDelta = true;

          const issues = await octokit.issues.listForRepo({
            owner,
            repo,
            labels: slug,
            filter: "all",
            state: "open",
            sort: "created",
            direction: "desc",
            per_page: 1,
          });
          console.log(`Found ${issues.data.length} issues`);

          // Don't create an issue if it's expected that the site is down or degraded
          let expected = false;
          if (
            (status === "down" &&
              ongoingMaintenanceEvents.find((i) => i.metadata.expectedDown.includes(slug))) ||
            (status === "degraded" &&
              ongoingMaintenanceEvents.find((i) => i.metadata.expectedDegraded.includes(slug)))
          )
            expected = true;

          // If the site was just recorded as down or degraded, open an issue
          if ((status === "down" || status === "degraded") && !expected) {
            if (!issues.data.length) {
              const newIssue = await octokit.issues.create({
                owner,
                repo,
                title:
                  status === "down"
                    ? `🛑 ${site.name} is down`
                    : `⚠️ ${site.name} has degraded performance`,
                body: `In [\`${lastCommitSha.substr(
                  0,
                  7
                )}\`](https://github.com/${owner}/${repo}/commit/${lastCommitSha}), ${site.name} (${
                  site.url
                }) ${status === "down" ? "was **down**" : "experienced **degraded performance**"}:
- HTTP code: ${result.httpCode}
- Response time: ${responseTime} ms
`,
                labels: ["status", slug, ...site.tags || []],
              });
              const assignees = [...(config.assignees || []), ...(site.assignees || [])];
              await octokit.issues.addAssignees({
                owner,
                repo,
                issue_number: newIssue.data.number,
                assignees,
              });
              await octokit.issues.lock({
                owner,
                repo,
                issue_number: newIssue.data.number,
              });
              console.log("Opened and locked a new issue");
              try {
                await sendNotification(
                  status === "down"
                    ? `🟥 ${site.name} (${site.url}) is **down**: ${newIssue.data.html_url}`
                    : `🟨 ${site.name} (${site.url}) is experiencing **degraded performance**: ${newIssue.data.html_url}`
                );
              } catch (error) {
                console.log(error);
              }
            } else {
              console.log("An issue is already open for this");
            }
          } else if (issues.data.length) {
            // If the site just came back up
            await octokit.issues.createComment({
              owner,
              repo,
              issue_number: issues.data[0].number,
              body: `**Resolved:** ${site.name} ${
                issues.data[0].title.includes("degraded")
                  ? "performance has improved"
                  : "is back up"
              } in [\`${lastCommitSha.substr(
                0,
                7
              )}\`](https://github.com/${owner}/${repo}/commit/${lastCommitSha}).`,
            });
            console.log("Created comment in issue");
            await octokit.issues.update({
              owner,
              repo,
              issue_number: issues.data[0].number,
              state: "closed",
            });
            console.log("Closed issue");
            try {
              await sendNotification(
                `🟩 ${site.name} (${site.url}) ${
                  issues.data[0].title.includes("degraded")
                    ? "performance has improved"
                    : "is back up"
                }.`
              );
            } catch (error) {
              console.log(error);
            }
          } else {
            console.log("Could not find a relevant issue", issues.data);
          }
        } else {
          console.log("Status is the same", currentStatus, status);
        }
      } else {
        console.log("Skipping commit, ", "status is", status);
      }
    } catch (error) {
      console.log("ERROR", error);
    }
  }
  push();

  if (hasDelta) generateSummary();
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
