<script setup lang="ts">
import { computed } from "vue";
import { useData, withBase } from "vitepress";

type ThemeMeta = {
  repoFullName?: string;
  repoUrl?: string;
  version?: string;
};

const { site } = useData();
const themeMeta = computed<ThemeMeta>(() => (site.value.themeConfig ?? {}) as ThemeMeta);

const repoFullName = computed(() => themeMeta.value.repoFullName || "codefriday/forgeops");
const repoUrl = computed(() => themeMeta.value.repoUrl || `https://github.com/${repoFullName.value}`);
const version = computed(() => themeMeta.value.version || "dev");

const starBadge = computed(
  () => `https://img.shields.io/github/stars/${repoFullName.value}?style=social`
);

const forkBadge = computed(
  () => `https://img.shields.io/github/forks/${repoFullName.value}?style=social`
);

const versionBadge = computed(
  () => `https://img.shields.io/badge/version-v${encodeURIComponent(version.value)}-f97316`
);

const zhLink = computed(() => withBase("/zh/"));
const enLink = computed(() => withBase("/en/"));
</script>

<template>
  <div class="forgeops-nav-meta">
    <a class="meta-badge" :href="repoUrl" target="_blank" rel="noreferrer">
      <img :src="starBadge" alt="GitHub stars" />
    </a>
    <a class="meta-badge" :href="`${repoUrl}/fork`" target="_blank" rel="noreferrer">
      <img :src="forkBadge" alt="GitHub forks" />
    </a>
    <a class="meta-badge" :href="repoUrl" target="_blank" rel="noreferrer">
      <img :src="versionBadge" alt="ForgeOps version" />
    </a>
    <a class="lang-pill" :href="zhLink">ZH</a>
    <a class="lang-pill" :href="enLink">EN</a>
  </div>
</template>
