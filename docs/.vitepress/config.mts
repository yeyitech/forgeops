import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitepress";

const repository = process.env.GITHUB_REPOSITORY ?? "codefriday/forgeops";
const repoName = repository.includes("/") ? repository.split("/")[1] : repository;
const defaultBase = !repoName || repoName.endsWith(".github.io") ? "/" : `/${repoName}/`;
const siteBase = process.env.SITE_BASE ?? defaultBase;
const repoUrl = `https://github.com/${repository}`;

const packageJsonPath = path.resolve(process.cwd(), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const siteVersion = String(packageJson.version ?? "0.1.0");

export default defineConfig({
  title: "ForgeOps",
  description: "Runtime-agnostic AI R&D control plane",
  lang: "zh-CN",
  base: siteBase,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", href: "/logo.png" }],
  ],
  themeConfig: {
    siteTitle: "ForgeOps",
    logo: "/logo.png",
    repoFullName: repository,
    repoUrl,
    version: siteVersion,
    search: {
      provider: "local",
    },
    nav: [
      { text: "Home", link: "/" },
      { text: "中文", link: "/zh/" },
      { text: "English", link: "/en/" },
      { text: "Brand (HTML)", link: "/harness-engineering.html" },
      { text: "Docs", link: "/00-index" },
    ],
    sidebar: [
      {
        text: "Language",
        items: [
          { text: "中文入口 /zh/", link: "/zh/" },
          { text: "English Entry /en/", link: "/en/" },
          { text: "品牌完整页（HTML）", link: "/harness-engineering.html" },
          { text: "品牌页（中文）", link: "/zh/brand" },
          { text: "Brand Page (English)", link: "/en/brand" },
        ],
      },
      {
        text: "Start Here",
        items: [
          { text: "站点首页", link: "/" },
          { text: "1 页上手卡", link: "/user-quickstart" },
          { text: "用户手册", link: "/user-guide" },
          { text: "项目初始化说明", link: "/project-init-user-guide" },
          { text: "文档地图", link: "/00-index" },
        ],
      },
      {
        text: "Architecture",
        collapsed: true,
        items: [
          { text: "Overview", link: "/architecture/00-overview" },
          { text: "Layering", link: "/architecture/layering" },
          { text: "ADR-0001", link: "/architecture/ADR-0001" },
          { text: "Runtime Adapter", link: "/runtime-adapter-design" },
        ],
      },
      {
        text: "Design",
        collapsed: true,
        items: [
          { text: "Core Beliefs", link: "/design/core-beliefs" },
          { text: "Skill Driven Delivery", link: "/design/skill-driven-delivery" },
          { text: "Codex Follow Policy", link: "/design/codex-upstream-follow-policy" },
          { text: "Session Mechanics", link: "/design/codex-runtime-session-mechanics" },
        ],
      },
      {
        text: "Quality & Governance",
        collapsed: true,
        items: [
          { text: "Verification Status", link: "/quality/verification-status" },
          { text: "Domain Grades", link: "/quality/domain-grades" },
          { text: "Golden Principles", link: "/quality/golden-principles" },
          { text: "Doc Freshness", link: "/meta/doc-freshness" },
          { text: "Doc Structure", link: "/meta/doc-structure" },
        ],
      },
      {
        text: "Planning & Reference",
        collapsed: true,
        items: [
          { text: "Tech Debt Tracker", link: "/exec-plans/tech-debt-tracker" },
          { text: "Context Index", link: "/context/index" },
          { text: "Product Specs", link: "/product-specs/index" },
          { text: "References", link: "/references/index" },
        ],
      },
    ],
    outline: {
      level: [2, 3],
    },
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 ForgeOps contributors",
    },
  },
});
