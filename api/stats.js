const fetch = require("node-fetch");

async function fetchGitHubData(username, orgLogins) {
  const token = process.env.GITHUB_TOKEN || "";
  const headers = {
    Authorization: token ? `Bearer ${token}` : "",
    "Content-Type": "application/json",
  };

  try {
    // First get user creation date
    const userResponse = await fetch(`https://api.github.com/users/${username}`, {
      headers,
    });
    
    if (!userResponse.ok) {
      throw new Error(`User API returned ${userResponse.status}`);
    }
    
    const userData = await userResponse.json();
    
    if (!userData.created_at) {
      throw new Error(`User ${username} not found`);
    }
    
    const createdAt = userData.created_at;

    // Try to fetch with organization contributions
    try {
      return await fetchWithOrgContributions(username, headers, createdAt, orgLogins);
    } catch (orgError) {
      console.error("Failed to fetch org contributions:", orgError.message);
      console.log("Falling back to user-only contributions");
      
      // Fallback to user-only contributions
      return await fetchUserOnlyContributions(username, headers, createdAt);
    }
  } catch (error) {
    console.error("Fatal error in fetchGitHubData:", error);
    throw error;
  }
}

async function fetchOrganizationsByLogin(orgLogins, headers) {
  const cleanLogins = orgLogins
    .map((login) => String(login).trim())
    .filter((login) => /^[A-Za-z0-9-]+$/.test(login));

  if (cleanLogins.length === 0) {
    return [];
  }

  const orgsQuery = `
    query {
      ${cleanLogins
        .map(
          (login, index) => `
        org${index}: organization(login: "${login}") {
          id
          login
          avatarUrl
        }
      `
        )
        .join("\n")}
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: orgsQuery }),
  });

  if (!response.ok) {
    throw new Error(`Org lookup GraphQL API error: ${response.status}`);
  }

  const data = await response.json();
  if (data.errors) {
    console.error("Org lookup GraphQL errors:", data.errors.map((e) => e.message));
  }

  const orgs = Object.values(data.data || {}).filter(Boolean);
  return orgs;
}

async function fetchWithOrgContributions(username, headers, createdAt, orgLogins) {
  // Query to get user's organizations
  const orgsQuery = `
    query($username: String!) {
      user(login: $username) {
        organizations(first: 100) {
          nodes {
            id
            login
            avatarUrl
          }
        }
      }
      viewer {
        login
        organizations(first: 100) {
          nodes {
            id
            login
            avatarUrl
          }
        }
      }
    }
  `;

  const orgsResponse = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query: orgsQuery, variables: { username } }),
  });

  if (!orgsResponse.ok) {
    throw new Error(`Orgs GraphQL API error: ${orgsResponse.status}`);
  }

  const orgsData = await orgsResponse.json();
  
  if (orgsData.errors) {
    throw new Error(`GraphQL error: ${orgsData.errors[0].message}`);
  }

  if (!orgsData.data || !orgsData.data.user) {
    throw new Error(`User ${username} not found in GraphQL`);
  }

  const userOrgs = orgsData.data.user.organizations.nodes || [];
  const viewerLogin = orgsData.data.viewer?.login;
  const viewerOrgs = orgsData.data.viewer?.organizations?.nodes || [];
  let organizations =
    userOrgs.length > 0
      ? userOrgs
      : viewerLogin && viewerLogin.toLowerCase() === username.toLowerCase()
      ? viewerOrgs
      : [];

  if (Array.isArray(orgLogins) && orgLogins.length > 0) {
    const forcedOrgs = await fetchOrganizationsByLogin(orgLogins, headers);
    if (forcedOrgs.length > 0) {
      organizations = forcedOrgs;
    }
  }
  console.log(
    `Found ${organizations.length} organizations for ${username} (user=${userOrgs.length}, viewer=${viewerOrgs.length}, viewerLogin=${viewerLogin})`
  );

  // Build query for user contributions + all org contributions
  const contributionFragments = (includePrivate) =>
    organizations
      .map(
        (org, index) => `
    org${index}: contributionsCollection(organizationID: "${org.id}"${
          includePrivate ? ", includePrivateContributions: true" : ""
        }) {
      contributionCalendar {
        totalContributions
      }
    }
  `
      )
      .join("\n");

  const contributionsField = (includePrivate) => `
        contributionsCollection${
          includePrivate ? "(includePrivateContributions: true)" : ""
        } {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
              }
            }
          }
        }`;

  const buildQuery = (includePrivate) => `
    query($username: String!) {
      user(login: $username) {
        ${contributionsField(includePrivate)}
        ${contributionFragments(includePrivate)}
        repositories(first: 100, ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            stargazerCount
            forkCount
            isFork
            languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
              edges {
                size
                node {
                  name
                  color
                }
              }
            }
          }
        }
      }
    }
  `;
  const fetchUserData = async (includePrivate) => {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: buildQuery(includePrivate), variables: { username } }),
    });

    if (!response.ok) {
      throw new Error(`Main GraphQL API error: ${response.status}`);
    }

    return response.json();
  };

  const isIncludePrivateArgError = (errors) =>
    Array.isArray(errors) &&
    errors.some(
      (error) =>
        typeof error.message === "string" &&
        error.message.includes("includePrivateContributions") &&
        error.message.includes("doesn't accept argument")
    );

  let data = await fetchUserData(true);

  if (data.errors && isIncludePrivateArgError(data.errors)) {
    data = await fetchUserData(false);
  }

  if (data.errors) {
    throw new Error(`GraphQL error: ${data.errors[0].message}`);
  }

  if (!data.data || !data.data.user) {
    throw new Error(`User ${username} not found`);
  }

  // NOTE: contributionsCollection without organizationID already includes org activity.
  // Merging org-specific calendars will double count, so we return the user's calendar as-is.

  const organizationsWithContributions = organizations.map((org, index) => {
    const aliasKey = `org${index}`;
    const orgData = data.data.user[aliasKey];
    return {
      login: org.login,
      avatarUrl: org.avatarUrl,
      contributions: orgData?.contributionCalendar?.totalContributions ?? 0,
    };
  });

  return {
    calendar: data.data.user.contributionsCollection.contributionCalendar,
    repositories: data.data.user.repositories.nodes,
    createdAt: createdAt,
    organizations: organizationsWithContributions,
  };
}

async function fetchUserOnlyContributions(username, headers, createdAt) {
  const contributionsField = (includePrivate) => `
        contributionsCollection${
          includePrivate ? "(includePrivateContributions: true)" : ""
        } {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                date
              }
            }
          }
        }`;

  const buildQuery = (includePrivate) => `
    query($username: String!) {
      user(login: $username) {
        ${contributionsField(includePrivate)}
        repositories(first: 100, ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            stargazerCount
            forkCount
            isFork
            languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
              edges {
                size
                node {
                  name
                  color
                }
              }
            }
          }
        }
      }
    }
  `;
  const fetchUserData = async (includePrivate) => {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({ query: buildQuery(includePrivate), variables: { username } }),
    });

    if (!response.ok) {
      throw new Error(`GraphQL API returned ${response.status}`);
    }

    return response.json();
  };

  const isIncludePrivateArgError = (errors) =>
    Array.isArray(errors) &&
    errors.some(
      (error) =>
        typeof error.message === "string" &&
        error.message.includes("includePrivateContributions") &&
        error.message.includes("doesn't accept argument")
    );

  let data = await fetchUserData(true);

  if (data.errors && isIncludePrivateArgError(data.errors)) {
    data = await fetchUserData(false);
  }

  if (data.errors) {
    throw new Error(data.errors[0].message);
  }

  if (!data.data || !data.data.user) {
    throw new Error(`User ${username} not found`);
  }

  return {
    calendar: data.data.user.contributionsCollection.contributionCalendar,
    repositories: data.data.user.repositories.nodes,
    createdAt: createdAt,
    organizations: [],
  };
}

function mergeContributions(contributionCollections) {
  // Create a map to deduplicate and sum contributions by date
  const contributionMap = new Map();
  let totalContributions = 0;

  contributionCollections.forEach(collection => {
    if (!collection || !collection.contributionCalendar) {
      return;
    }
    
    collection.contributionCalendar.weeks.forEach(week => {
      if (!week.contributionDays) return;
      
      week.contributionDays.forEach(day => {
        const existing = contributionMap.get(day.date) || 0;
        contributionMap.set(day.date, existing + day.contributionCount);
      });
    });
  });

  // Convert map back to weeks structure
  const sortedDates = Array.from(contributionMap.keys()).sort();
  
  if (sortedDates.length === 0) {
    return {
      totalContributions: 0,
      weeks: []
    };
  }
  
  const weeks = [];
  let currentWeek = [];
  
  sortedDates.forEach((date, index) => {
    const dayOfWeek = new Date(date + 'T00:00:00Z').getUTCDay();
    
    // Start a new week on Sunday (day 0)
    if (dayOfWeek === 0 && currentWeek.length > 0) {
      weeks.push({ contributionDays: currentWeek });
      currentWeek = [];
    }
    
    const count = contributionMap.get(date);
    currentWeek.push({
      contributionCount: count,
      date: date
    });
    totalContributions += count;
  });
  
  // Add the last week
  if (currentWeek.length > 0) {
    weeks.push({ contributionDays: currentWeek });
  }

  return {
    totalContributions,
    weeks
  };
}

function calculateLanguageStats(repositories) {
  const languageMap = {};

  repositories.filter((repo) => !repo.isFork).forEach((repo) => {
    repo.languages.edges.forEach((edge) => {
      const { name, color } = edge.node;
      const { size } = edge;

      if (languageMap[name]) {
        languageMap[name].size += size;
      } else {
        languageMap[name] = { size, color: color || "#858585" };
      }
    });
  });

  const totalSize = Object.values(languageMap).reduce(
    (sum, lang) => sum + lang.size,
    0
  );

  if (totalSize === 0) {
    return [];
  }

  return Object.entries(languageMap)
    .map(([name, data]) => ({
      name,
      color: data.color,
      percentage: ((data.size / totalSize) * 100).toFixed(2),
      size: data.size,
    }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 6);
}

function calculateStreaks(weeks) {
  const allDays = weeks.flatMap((week) => week.contributionDays);

  if (allDays.length === 0) {
    return {
      current: 0,
      currentStart: null,
      longest: 0,
      longestStart: null,
      longestEnd: null,
    };
  }

  // Get today's date in UTC (same as GitHub's contribution graph)
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split("T")[0];

  let longestStreak = 0;
  let longestStreakStart = null;
  let longestStreakEnd = null;

  let currentStreak = 0;
  let currentStreakStart = null;

  let tempStreak = 0;
  let tempStreakStart = null;

  // Iterate through all days from oldest to newest
  for (let i = 0; i < allDays.length; i++) {
    const day = allDays[i];
    const dayDate = new Date(day.date + "T00:00:00Z");

    if (day.contributionCount > 0) {
      if (tempStreak === 0) {
        tempStreakStart = day.date;
      }
      tempStreak++;

      // Update longest streak if current temp streak is longer
      if (tempStreak > longestStreak) {
        longestStreak = tempStreak;
        longestStreakStart = tempStreakStart;
        longestStreakEnd = day.date;
      }
    } else {
      // Reset temp streak when we hit a day with no contributions
      tempStreak = 0;
      tempStreakStart = null;
    }
  }

  // Calculate current streak by iterating backwards from today
  for (let i = allDays.length - 1; i >= 0; i--) {
    const day = allDays[i];
    const dayDate = new Date(day.date + "T00:00:00Z");

    // Stop if we've gone past today (shouldn't happen, but safety check)
    if (dayDate > today) continue;

    if (day.contributionCount > 0) {
      currentStreak++;
      currentStreakStart = day.date;
    } else {
      // If we hit a day with no contributions
      // Only break if this is not today (to preserve streak if user hasn't contributed yet today)
      if (day.date !== todayStr) {
        break;
      }
    }
  }

  return {
    current: currentStreak,
    currentStart: currentStreakStart || todayStr,
    longest: longestStreak,
    longestStart: longestStreakStart || allDays[0]?.date || todayStr,
    longestEnd: longestStreakEnd || todayStr,
  };
}

function getLast100Days(weeks) {
  const allDays = weeks.flatMap((week) => week.contributionDays);
  return allDays.slice(-100);
}

function formatDate(dateStr) {
  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatShortDate(dateStr) {
  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function getContrastColor(hexColor) {
  const hex = hexColor.replace("#", "");
  if (hex.length !== 6) return "#ffffff";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#000000" : "#ffffff";
}

function buildShieldUrl(label, colorHex) {
  const cleanColor = colorHex.replace("#", "");
  const encodedLabel = encodeURIComponent(label).replace(/%20/g, "_");
  return `https://img.shields.io/badge/${encodedLabel}-${cleanColor}?style=for-the-badge`;
}

// Convert image URL to base64 data URI for embedding in SVG
async function fetchImageAsBase64(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.buffer();
    const contentType = response.headers.get("content-type") || "image/png";
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.error("Failed to fetch image:", url, error.message);
    return null;
  }
}

// Calculate relative luminance to determine if text should be light or dark
function getContrastTextColor(hexColor) {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substr(0, 2), 16) / 255;
  const g = parseInt(hex.substr(2, 2), 16) / 255;
  const b = parseInt(hex.substr(4, 2), 16) / 255;
  // Relative luminance formula
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

// Generate native SVG badge instead of external shields.io
function generateSvgBadge(label, colorHex, x, y, width, height) {
  const cleanColor = colorHex.startsWith("#") ? colorHex : `#${colorHex}`;
  const textColor = getContrastTextColor(cleanColor);
  const textX = x + width / 2;
  const textY = y + height / 2 + 4;
  return `
    <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="4" fill="${cleanColor}"/>
    <text x="${textX}" y="${textY}" text-anchor="middle" font-size="11" font-weight="600" fill="${textColor}" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif">${label}</text>
  `;
}

function getAccountCreationDate(createdAt) {
  const date = new Date(createdAt);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function calculateRepoStats(repositories) {
  const sourceRepos = repositories.filter((repo) => !repo.isFork);
  const totalStars = sourceRepos.reduce(
    (sum, repo) => sum + repo.stargazerCount,
    0
  );
  const totalForks = sourceRepos.reduce(
    (sum, repo) => sum + repo.forkCount,
    0
  );
  return { totalStars, totalForks };
}

function generateSVG(
  totalContributions,
  streaks,
  activityDays,
  languages,
  createdAt,
  repoStats,
  organizations
) {
  const width = 800;
  const height = 950;
  const graphWidth = 720;
  const graphHeight = 140;
  const padding = 30;

  const maxContributions = Math.max(
    ...activityDays.map((d) => d.contributionCount),
    1
  );

  // Generate smooth curve path for activity graph using quadratic bezier curves
  const points = activityDays.map((day, index) => {
    const x =
      padding +
      (index / (activityDays.length - 1)) * (graphWidth - 2 * padding);
    const axisY = graphHeight - padding;
    const usableHeight = graphHeight - 2 * padding;
    const yRaw =
      axisY -
      (day.contributionCount / maxContributions) * usableHeight;
    const y = Math.min(axisY, yRaw);
    return { x, y, count: day.contributionCount };
  });

  // Create smooth curve using quadratic bezier
  let linePath = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const midX = (prev.x + curr.x) / 2;
    const axisY = graphHeight - padding;
    const midY = Math.min(axisY, (prev.y + curr.y) / 2);
    linePath += ` Q ${prev.x},${prev.y} ${midX},${midY}`;
    if (i === points.length - 1) {
      linePath += ` Q ${curr.x},${curr.y} ${curr.x},${curr.y}`;
    }
  }

  const areaPath = `${linePath} L ${graphWidth - padding},${
    graphHeight - padding
  } L ${padding},${graphHeight - padding} Z`;

  const sundayLabels = activityDays
    .map((day, index) => {
      const dayOfWeek = new Date(day.date + "T00:00:00Z").getUTCDay();
      if (dayOfWeek !== 0) return "";
      const x =
        padding +
        (index / (activityDays.length - 1)) * (graphWidth - 2 * padding);
      return `<text x="${x}" y="${graphHeight - padding + 16}" class="axis-label" text-anchor="middle">${formatShortDate(
        day.date
      )}</text>`;
    })
    .filter(Boolean)
    .join("");

  // Generate grid lines
  const gridLines = [];
  for (let i = 0; i <= 4; i++) {
    const y = padding + (i * (graphHeight - 2 * padding)) / 4;
    const value = Math.round(maxContributions * (1 - i / 4));
    gridLines.push(
      `<line x1="${padding}" y1="${y}" x2="${
        graphWidth - padding
      }" y2="${y}" class="grid-line"/>
      <text x="${padding - 15}" y="${
        y + 4
      }" class="axis-label" text-anchor="end">${value}</text>`
    );
  }

  const accountCreated = getAccountCreationDate(createdAt);
  const longestStartDate = formatDate(streaks.longestStart);
  const longestEndDate = formatDate(streaks.longestEnd);
  const currentStartDate = formatDate(streaks.currentStart);

  // Generate language bar
  let currentX = 0;
  const pieCenterX = 180;
  const pieCenterY = 838;
  const pieRadius = 86;
  const pieCircumference = 2 * Math.PI * pieRadius;
  const totalPercentage = languages.reduce(
    (sum, lang) => sum + parseFloat(lang.percentage),
    0
  );
  const pieSegments = [
    ...languages.map((lang) => ({
      color: lang.color,
      percentage: parseFloat(lang.percentage),
    })),
  ];

  if (totalPercentage < 100) {
    pieSegments.push({
      color: "#8b949e",
      percentage: 100 - totalPercentage,
    });
  }

  let cumulativeAngle = -Math.PI / 2;
  const pieChart = pieSegments
    .map((segment, index) => {
      const angle = (segment.percentage / 100) * Math.PI * 2;
      const startAngle = cumulativeAngle;
      const endAngle = cumulativeAngle + angle;
      cumulativeAngle = endAngle;

      const x1 = pieCenterX + pieRadius * Math.cos(startAngle);
      const y1 = pieCenterY + pieRadius * Math.sin(startAngle);
      const x2 = pieCenterX + pieRadius * Math.cos(endAngle);
      const y2 = pieCenterY + pieRadius * Math.sin(endAngle);
      const largeArc = angle > Math.PI ? 1 : 0;

      return `
        <path d="M ${pieCenterX} ${pieCenterY} L ${x1} ${y1} A ${pieRadius} ${pieRadius} 0 ${largeArc} 1 ${x2} ${y2} Z" fill="${segment.color}" opacity="0">
          <animate attributeName="opacity" from="0" to="1" dur="0.8s" begin="${
            index * 0.15
          }s" fill="freeze"/>
        </path>
      `;
    })
    .join("");

  // Generate language list with native SVG badges (no external images)
  const languageBadges = languages
    .map((lang, index) => {
      const row = Math.floor(index / 2);
      const col = index % 2;
      const x = col === 0 ? 300 : 540;
      const y = 770 + row * 46;
      const badgeHeight = 28;
      const label = `${lang.name} ${lang.percentage}%`;
      const badgeWidth = Math.max(120, label.length * 8 + 20);

      return generateSvgBadge(label, lang.color, x, y, badgeWidth, badgeHeight);
    })
    .join("");

  const orgs = (organizations || [])
    .slice()
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, 4);

  const orgCards = orgs
    .map((org, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = col === 0 ? 60 : 420;
      const y = 470 + row * 68;
      const clipId = `orgClip${index}`;
      // Use base64 data URI if available, fallback to original URL
      const imgSrc = org.avatarBase64 || org.avatarUrl;
      return `
        <clipPath id="${clipId}">
          <circle cx="${x + 18}" cy="${y - 10}" r="18"/>
        </clipPath>
        <image href="${imgSrc}" x="${x}" y="${y - 28}" width="36" height="36" clip-path="url(#${clipId})"/>
        <text x="${x + 50}" y="${y - 6}" class="text stat-label">${org.login}</text>
        <text x="${x + 50}" y="${y + 14}" class="text stat-detail">${org.contributions.toLocaleString()} contributions</text>
      `;
    })
    .join("");

  const orgEmptyState = `
    <text x="60" y="515" class="text stat-detail">No organization data available</text>
  `;

  return `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; }
      .text { fill: #e6edf3; }
      .border { stroke: #30363d; }
      .grid-line { stroke: #21262d; }
      .axis-label { fill: #7d8590; }
      .section-bg { fill: #161b22; }
      .section-bg-strong { fill: #161b22; }
      .accent-red { fill: #f85149; }
      .accent-blue { fill: #58a6ff; }
      .accent-green { fill: #3fb950; }
      .accent-purple { fill: #a371f7; }
    }
    @media (prefers-color-scheme: light) {
      .bg { fill: #ffffff; }
      .text { fill: #1f2328; }
      .border { stroke: #d0d7de; }
      .grid-line { stroke: #e6e9ed; }
      .axis-label { fill: #57606a; }
      .section-bg { fill: #f6f8fa; }
      .section-bg-strong { fill: #f6f8fa; }
      .accent-red { fill: #f85149; }
      .accent-blue { fill: #58a6ff; }
      .accent-green { fill: #3fb950; }
      .accent-purple { fill: #a371f7; }
    }
    .stat-number { font-size: 52px; font-weight: 700; font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
    .stat-label { font-size: 15px; font-weight: 600; letter-spacing: 0.3px; }
    .stat-detail { font-size: 12px; opacity: 0.75; }
    .lang-text { font-size: 15px; font-weight: 500; }
    .lang-percentage { font-size: 16px; font-weight: 600; opacity: 0.8; }
    .section-title { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
    .graph-line { stroke: #3fb950; stroke-width: 3; fill: none; stroke-linecap: round; stroke-linejoin: round; filter: url(#glow); }
    .graph-area { fill: url(#gradient); opacity: 0.28; }
    .grid-line { stroke-width: 1; opacity: 0.3; }
    .axis-label { font-size: 11px; font-weight: 500; }
    .text { font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; }
    .soft-shadow { filter: url(#softShadow); }
    .soft-ring { filter: url(#ringGlow); }
    .stat-bubble { animation: float 6s ease-in-out infinite; transform-origin: center; }
    .stat-bubble:nth-of-type(2) { animation-delay: 0.8s; }
    .stat-bubble:nth-of-type(3) { animation-delay: 1.6s; }
    .graph-line { stroke-dasharray: 100; stroke-dashoffset: 100; animation: draw 2.2s ease-out forwards; }
    .graph-area { animation: areaPulse 6s ease-in-out infinite; }
    .bg-sheen { animation: sheen 10s ease-in-out infinite; }
    .section-sheen { animation: sheen 8s ease-in-out infinite; opacity: 0.18; }
    .lang-percentage { animation: softBlink 5s ease-in-out infinite; }

    @keyframes draw {
      to { stroke-dashoffset: 0; }
    }
    @keyframes areaPulse {
      0%, 100% { opacity: 0.24; }
      50% { opacity: 0.36; }
    }
    @keyframes float {
      0%, 100% { transform: translateY(0px) scale(1); }
      50% { transform: translateY(-3px) scale(1.02); }
    }
    @keyframes sheen {
      0% { transform: translateX(-20px); opacity: 0.12; }
      50% { transform: translateX(20px); opacity: 0.22; }
      100% { transform: translateX(-20px); opacity: 0.12; }
    }
    @keyframes softBlink {
      0%, 100% { opacity: 0.7; }
      50% { opacity: 0.95; }
    }
  </style>
  
  <defs>
    <linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#3fb950" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#3fb950" stop-opacity="0.1"/>
    </linearGradient>
    <radialGradient id="spotlight" cx="30%" cy="0%" r="70%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="softShadow">
      <feGaussianBlur in="SourceAlpha" stdDeviation="6" result="blur"/>
      <feOffset dy="6" result="offset"/>
      <feColorMatrix type="matrix" values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0   0 0 0 0.18 0" result="shadow"/>
      <feMerge>
        <feMergeNode in="shadow"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="glow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <filter id="ringGlow">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  
  <!-- Background -->
  <rect width="${width}" height="${height}" class="bg" rx="16"/>
  <rect width="${width}" height="${height}" fill="url(#spotlight)" rx="16" class="bg-sheen"/>
  
  <!-- Stats Container -->
  <rect x="10" y="10" width="780" height="160" class="section-bg soft-shadow" rx="14"/>
  <rect x="10" y="10" width="780" height="160" fill="none" class="border" stroke-width="1.5" rx="14"/>
  <rect x="18" y="18" width="764" height="144" fill="url(#spotlight)" rx="12" class="section-sheen"/>
  
  <!-- Total Contributions -->
  <g transform="translate(140, 90)">
    <circle cx="0" cy="0" r="52" class="accent-red stat-bubble soft-ring" opacity="0.14"/>
    <text x="0" y="8" class="text stat-number accent-red" text-anchor="middle">${totalContributions.toLocaleString()}</text>
    <text x="0" y="31" class="accent-red stat-label" text-anchor="middle">Total Contributions</text>
    <text x="0" y="50" class="text stat-detail" text-anchor="middle">${accountCreated} - Present</text>
  </g>
  
  <!-- Current Streak -->
  <g transform="translate(400, 90)">
    <circle cx="0" cy="0" r="52" class="accent-blue stat-bubble soft-ring" opacity="0.14"/>
    <path d="M -8 -22 Q -8 -27 -3 -27 L -3 -32 Q -3 -37 -8 -37 Q -13 -37 -13 -32 L -13 -27 Q -13 -27 -8 -22 M 8 -22 Q 8 -27 3 -27 L 3 -32 Q 3 -37 8 -37 Q 13 -37 13 -32 L 13 -27 Q 13 -27 8 -22 Z" class="accent-blue" opacity="0.7"/>
    <text x="0" y="8" class="text stat-number accent-blue" text-anchor="middle">${
      streaks.current
    }</text>
    <text x="0" y="31" class="accent-blue stat-label" text-anchor="middle">Current Streak</text>
    <text x="0" y="50" class="text stat-detail" text-anchor="middle">${currentStartDate} - Present</text>
  </g>
  
  <!-- Longest Streak -->
  <g transform="translate(660, 90)">
    <circle cx="0" cy="0" r="52" class="accent-purple stat-bubble soft-ring" opacity="0.14"/>
    <text x="0" y="8" class="text stat-number accent-purple" text-anchor="middle">${
      streaks.longest
    }</text>
    <text x="0" y="31" class="accent-purple stat-label" text-anchor="middle">Longest Streak</text>
    <text x="0" y="50" class="text stat-detail" text-anchor="middle">${longestStartDate} - ${longestEndDate}</text>
  </g>
  
  <!-- Dividers -->
  <line x1="270" y1="30" x2="270" y2="150" class="border" stroke-width="2" opacity="0.3"/>
  <line x1="530" y1="30" x2="530" y2="150" class="border" stroke-width="2" opacity="0.3"/>
  
  <!-- Activity Graph Container -->
  <rect x="10" y="190" width="780" height="190" class="section-bg soft-shadow" rx="14"/>
  <rect x="10" y="190" width="780" height="190" fill="none" class="border" stroke-width="1.5" rx="14"/>
  
  <!-- Activity Graph Title -->
  <text x="30" y="218" class="text section-title">Contribution Activity (Last 100 Days)</text>
  
  <!-- Activity Graph -->
  <g transform="translate(30, 240)">
    <!-- Grid lines -->
    ${gridLines.join("")}
    
    <!-- Graph area and line -->
    <path d="${areaPath}" class="graph-area"/>
    <path d="${linePath}" class="graph-line" pathLength="100"/>
    
    <!-- Axes -->
    <line x1="${padding}" y1="${graphHeight - padding}" x2="${
    graphWidth - padding
  }" y2="${graphHeight - padding}" class="border" stroke-width="2.5"/>
    <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${
    graphHeight - padding
  }" class="border" stroke-width="2.5"/>
    
    <!-- Axis labels -->
    ${sundayLabels}
  </g>

  <!-- Organizations Container -->
  <rect x="10" y="400" width="780" height="170" class="section-bg soft-shadow" rx="14"/>
  <rect x="10" y="400" width="780" height="170" fill="none" class="border" stroke-width="1.5" rx="14"/>
  <text x="30" y="430" class="text section-title">Organizations</text>
  <g>
    ${orgs.length ? orgCards : orgEmptyState}
  </g>
  
  <!-- Additional Stats Container -->
  <rect x="10" y="590" width="780" height="90" class="section-bg soft-shadow" rx="14"/>
  <rect x="10" y="590" width="780" height="90" fill="none" class="border" stroke-width="1.5" rx="14"/>
  
  <!-- Repository Stats -->
  <g transform="translate(0, 645)">
    <text x="200" y="0" class="text stat-number accent-blue" text-anchor="middle">${repoStats.totalStars.toLocaleString()}</text>
    <text x="200" y="22" class="accent-blue stat-label" text-anchor="middle">Total Stars</text>
    
    <text x="400" y="0" class="text stat-number accent-purple" text-anchor="middle">${repoStats.totalForks.toLocaleString()}</text>
    <text x="400" y="22" class="accent-purple stat-label" text-anchor="middle">Total Forks</text>
    
    <text x="600" y="0" class="text stat-number accent-green" text-anchor="middle">${
      languages.length
    }</text>
    <text x="600" y="22" class="accent-green stat-label" text-anchor="middle">Languages Used</text>
  </g>
  
  <line x1="310" y1="605" x2="310" y2="665" class="border" stroke-width="2" opacity="0.3"/>
  <line x1="490" y1="605" x2="490" y2="665" class="border" stroke-width="2" opacity="0.3"/>
  
  <!-- Languages Container -->
  <rect x="10" y="700" width="780" height="240" class="section-bg-strong soft-shadow" rx="14"/>
  <rect x="10" y="700" width="780" height="240" fill="none" class="border" stroke-width="1.5" rx="14"/>
  
  <!-- Languages Title -->
  <text x="30" y="728" class="text section-title">Most Used Languages</text>
  
  <!-- Language Pie Chart -->
  <g>
    ${pieChart}
  </g>
  
  <!-- Language Badges -->
  <g>
    ${languageBadges}
  </g>
</svg>
  `.trim();
}

module.exports = async (req, res) => {
  try {
    const { username, orgs } = req.query;

    if (!username) {
      return res.status(400).send("Username parameter is required");
    }

    const orgLogins = orgs
      ? String(orgs)
          .split(",")
          .map((org) => org.trim())
          .filter(Boolean)
      : [];

    const { calendar, repositories, createdAt, organizations } =
      await fetchGitHubData(username, orgLogins);
    
    // Fetch organization avatars as base64 to embed in SVG (GitHub blocks external images)
    const orgsWithBase64 = await Promise.all(
      (organizations || []).map(async (org) => {
        const avatarBase64 = await fetchImageAsBase64(org.avatarUrl);
        return { ...org, avatarBase64 };
      })
    );
    
    console.log(`=== Final Stats for ${username} ===`);
    console.log(`Total contributions in calendar: ${calendar.totalContributions}`);
    console.log(`Total weeks: ${calendar.weeks.length}`);
    console.log(`Total repositories: ${repositories.length}`);
    
    const streaks = calculateStreaks(calendar.weeks);
    const activityDays = getLast100Days(calendar.weeks);
    
    console.log(`Activity days (last 90): ${activityDays.length}`);
    console.log(`Current streak: ${streaks.current}, Longest streak: ${streaks.longest}`);
    
    const languages = calculateLanguageStats(repositories);
    const repoStats = calculateRepoStats(repositories);

    const svg = generateSVG(
      calendar.totalContributions,
      streaks,
      activityDays,
      languages,
      createdAt,
      repoStats,
      orgsWithBase64
    );

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=14400");
    res.status(200).send(svg);
  } catch (error) {
    console.error("Error generating stats:", error.message);
    console.error("Stack trace:", error.stack);
    res.status(500).send(`Error: ${error.message}`);
  }
};
