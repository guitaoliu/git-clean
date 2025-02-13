import execAsync, { exec } from "./execAsync.mjs";

import { LOCAL } from "./index.mjs";
import * as c from "yoctocolors";
import inquirer from "inquirer";
import ora from "ora";
import shell from "shelljs";
import urlJoin from "url-join";
import nodemailer from "nodemailer";

export default class Helper {
  conf = null;
  jiraProjects = [];
  transport = null;

  constructor(conf) {
    this.conf = conf;

    this.jiraProjects = this.getJiraProjects(conf);
    if (conf.SMTP_SERVER) {
      this.transport = nodemailer.createTransport({
        service: conf.SMTP_SERVER,
        auth: {
          user: conf.SMTP_USER,
          pass: conf.SMTP_PASSWORD,
        },
      });

      this.transport.verify((error) => {
        if (error) {
          console.error(c.red(error));
        } else {
          console.log(c.green("✔"), "Server is ready to take our messages");
        }
      });
    }
  }

  getBranches = async (type, mergeState) => {
    let branches = [];

    const spinner = ora("Finding branches...").start();

    try {
      switch (type) {
        case "local":
          branches = await this.fetchLocalBranches(mergeState);
          break;
        case "remote":
          branches = await this.fetchRemoteBranches(mergeState);
          break;
      }
    } catch (e) {
      spinner.fail().stop();
      console.error(e);
      shell.exit(1);
    }

    const total = branches.length;

    spinner.succeed().stop();

    console.log("Found", c.magenta(total), "branches...");

    if (total === 0) {
      shell.exit(0);
    }

    spinner.start("Getting branch information...");

    try {
      branches = await Promise.all(branches.map(this.getBranchInfo));

      branches = branches.sort((a, b) => a.date - b.date);
    } catch (e) {
      console.error(e);
      spinner.fail().stop();
      shell.exit(1);
    }

    spinner.succeed().stop();

    return branches;
  };

  groupByNone = (branches) => ({
    Branches: branches,
  });

  groupByAuthor = (branches) => {
    const groups = {};
    branches.forEach((branch) => {
      if (!(branch.author in groups)) {
        groups[branch.author] = [];
      }
      groups[branch.author].push(branch);
    });
    return groups;
  };

  branchesByAuthor = (branches, author) => {
    const group = {};
    branches.forEach((branch) => {
      if (branch.author.toLowerCase().includes(author.toLowerCase())) {
        if (!(branch.author in group)) {
          group[branch.author] = [];
        }
        group[branch.author].push(branch);
      }
    });
    return group;
  };

  prettyPrintByAuthor = (branchesByAuthor) => {
    // Sort by author first
    const authors = Object.keys(branchesByAuthor).sort();

    authors.forEach((author) => {
      const branches = branchesByAuthor[author];
      console.log(c.underline(c.green(author), "-", c.bold(c.red(branches.length))));
      console.log();
      branches.forEach((branch) =>
        console.log(c.magenta(branch.prettyDate.padEnd(25)), branch.prettyName.padEnd(75), c.cyan(branch.url))
      );
      console.log();
    });
  };

  deleteBranches = async (branches, type) => {
    const authors = Object.keys(branches).sort();

    const answers = await inquirer.prompt([
      {
        type: "checkbox",
        message: "Select branches to delete (use the Spacebar to select branches and Enter to confirm)",
        name: "branches",
        pageSize: 30,
        choices: authors.reduce((choices, author) => {
          return choices.concat(
            new inquirer.Separator(author),
            branches[author].map((branch) => {
              return { name: branch.prettyName, value: branch, checked: false };
            })
          );
        }, []),
      },
      {
        type: "confirm",
        name: "confirmDelete",
        message: "Are you sure you want to delete these branches?",
        default: false,
      },
    ]);

    if (answers.confirmDelete) {
      console.log(c.red("Deleting", answers.branches.length, "branches..."));

      // Start by pruning branches
      this.prune();

      if (answers.branches.length > 0) {
        const branchStr = answers.branches.map((branch) => branch.prettyName).join(" ");

        try {
          if (type === LOCAL) {
            exec(`git branch -D ${branchStr}`);
          } else {
            exec(`git push origin --delete ${branchStr}`);
          }
        } catch (e) {
          console.error(e);
          shell.exit(1);
        }
      }
      console.log(c.green("done."));
    } else {
      console.log("Exiting without deleting any branches.");
    }
  };

  emailLastCommitter = async (branchesByAuthor, mergeState) => {
    if (!this.transport) {
      console.log(c.red("No SMTP server configured. Skipping email."));
      return;
    }
    const authors = Object.keys(branchesByAuthor).sort();

    for (let i = 0; i < authors.length; i++) {
      const author = authors[i];
      const branches = branchesByAuthor[author];
      const { email } = branches[0];

      this.prettyPrintByAuthor({ [author]: branchesByAuthor[author] });

      const answers = await inquirer.prompt([
        {
          type: "confirm",
          name: "email",
          message: `Would you like to email ${c.underline(c.green(author))} <${email}> about these ${c.italic(
            mergeState === "merged" ? c.green("merged") : c.red("unmerged")
          )} branches?`,
          default: false,
        },
      ]);

      console.log();

      if (answers.email) {
        const html = this.getEmailHtml(author, mergeState, branches);
        console.log(`${c.green("✔")} Sending email to ${author} ${c.underline(email)}...`);
        await this.transport.sendMail({
          from: `Git Clean ${this.conf.SMTP_USER}`,
          to: email,
          subject: "Please clean up your branches",
          html: html,
        });
      }
    }
  };

  // ============================================================================================
  // PRIVATE FUNCTIONS
  // ============================================================================================
  fetchLocalBranches = async (mergeState) => {
    const command = `git branch --${mergeState} ${this.conf.MAIN_BRANCH}`;

    return this.execFetchBranches(command);
  };

  fetchRemoteBranches = (mergeState) => {
    let command = `git branch -r --${mergeState} ${this.conf.MAIN_BRANCH} | grep -v `;

    const protectedBranches = this.conf.PROTECTED_BRANCHES.split(",").map((b) => b.trim());

    command = command.concat(protectedBranches.map((b) => `-e ${b}`).join(" "));

    return this.execFetchBranches(command);
  };

  execFetchBranches = async (command) => {
    const output = await execAsync(command, { silent: true });

    const branches = this.sanitizeBranchOutput(output);

    return branches;
  };

  sanitizeBranchOutput = (input) => {
    return (
      input
        .split("\n")
        // Remove the asterisk from the git branch output
        .map((branch) => branch.replace(/^\*/, ""))

        // Remove all whitespace
        .map((branch) => branch.trim())

        // Remove any empty lines
        .filter((branch) => branch !== "")

        // Filter out the main branch
        .filter((branch) => !branch.includes(this.conf.MAIN_BRANCH))
    );
  };

  getJiraUrl = (branch) => {
    if (!this.jiraProjects) return "";

    const regex = new RegExp(`(${this.jiraProjects.join("|")})-[\\d]+`, "i");

    const result = regex.exec(branch);

    if (result === null) {
      return "";
    }

    return urlJoin(this.conf.REMOTE_URL, "browse", result[0]);
  };

  /**
   * Get detailed information for this branch.
   *
   *    %cn: committer name
   *    %cr: committer date, relative
   *    %cI: committer date (ISO 8601)
   */
  getBranchInfo = async (branch) => {
    let info = await execAsync(`git log -n 1 --pretty=format:"%cn | %cr | %cI | %ce" "${branch}"`, {
      silent: true,
    });

    info = info.split("|").map((info) => info.trim());

    return {
      author: info[0],
      prettyDate: info[1],
      date: new Date(info[2]),
      email: info[3],
      name: branch,
      prettyName: branch.replace("origin/", ""),
      url: this.getJiraUrl(branch),
    };
  };

  prettyPrint = (branch) => {
    console.log(
      c.blue(branch.prettyDate.padEnd(25)),
      c.green(branch.author.padEnd(25)),
      branch.prettyName.padEnd(75),
      c.cyan(branch.url)
    );
  };

  getJiraProjects = (conf) => {
    const confStr = conf.JIRA_PROJECTS;

    if (!confStr) return;

    return conf.JIRA_PROJECTS.split(",").map((b) => b.trim());
  };

  getEmailHtml = (author, mergeState, branches) => `
    <p> Hi ${author},</p>
    <p>
      This is a reminder that you are the last committer of the following branches. If the branches were
      created by you, please review them to see if they are still needed.
    </p>
    <p>
      If you are not the owner of the branch please contact the owner to see if it is still needed.
    </p>
    ${
      mergeState === "merged"
        ? `<p>The following branches have been merged into the <code>${this.conf.MAIN_BRANCH}</code> branch, please clean them up:</p>`
        : `<p>The following branches have not been merged into the <code>${this.conf.MAIN_BRANCH}</code> branch, please confirm if they are still under development:</p>`
    }
    <table style="border: 1px solid black; border-collapse: collapse; padding: 5px;">
      <thead>
        <tr>
          <th style="border: 1px solid black; border-collapse: collapse; padding: 5px">#</th>
          <th style="border: 1px solid black; border-collapse: collapse; padding: 5px">Name</th>
          <th style="border: 1px solid black; border-collapse: collapse; padding: 5px">Last Update</th>
          <th style="border: 1px solid black; border-collapse: collapse; padding: 5px">Jira</th>
          <th style="border: 1px solid black; border-collapse: collapse; padding: 5px">Merge State</th>
        </tr>
      </thead>
      <tbody>
        ${branches
          .map(
            (branch, idx) =>
              `<tr>
          <td style="border: 1px solid black; border-collapse: collapse; padding: 5px">${idx + 1}</td>
          <td style="border: 1px solid black; border-collapse: collapse; padding: 5px">${branch.prettyName}</td>
          <td style="border: 1px solid black; border-collapse: collapse; padding: 5px">${branch.prettyDate}</td>
          <td style="border: 1px solid black; border-collapse: collapse; padding: 5px">
            <a href="${branch.url}">${branch.url.split("/").pop()}</a>
          </td>
          <td style="border: 1px solid black; border-collapse: collapse; padding: 5px">${
            mergeState === "merged" ? "Merged" : "Unmerged"
          }</td>
        </tr>`
          )
          .join("\n")}
      </tbody>
    </table>
    <p>Thanks for your help! We appreciate it.</p>
    <p>Regards,</p>
    <p>Git Clean</p>`;

  prune = () => {
    exec("git remote prune origin");
  };
}
