const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();

function isValidMetricEvent(data) {
  return (
    data &&
    typeof data.userId === "string" &&
    typeof data.eventId === "string" &&
    typeof data.timestamp === "string" &&
    typeof data.date === "string" &&
    typeof data.month === "string" &&
    typeof data.originalTokens === "number" &&
    typeof data.optimizedTokens === "number" &&
    typeof data.tokensSaved === "number" &&
    data.originalTokens >= 0 &&
    data.optimizedTokens >= 0 &&
    data.tokensSaved >= 0 &&
    data.originalTokens < 100000 &&
    data.optimizedTokens < 100000 &&
    data.tokensSaved < 100000
  );
}

exports.trackOptimizationEvent = onRequest(
  {
    cors: true,
    region: "us-east1",
    invoker: "public"
  },
  async (req, res) => {
    try {
      if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
      }

      const data = req.body;

      if (!isValidMetricEvent(data)) {
        return res.status(400).json({ error: "Invalid metric event" });
      }

      const eventRef = db.collection("optimizationEvents").doc(data.eventId);
      const userRef = db.collection("users").doc(data.userId);
      const dailyRef = db.collection("dailyUserStats").doc(`${data.userId}_${data.date}`);
      const monthlyRef = db.collection("monthlyUserStats").doc(`${data.userId}_${data.month}`);

      await db.runTransaction(async (transaction) => {
        transaction.set(eventRef, {
          ...data,
          receivedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.set(
          userRef,
          {
            userId: data.userId,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
            extensionVersion: data.extensionVersion || "unknown"
          },
          { merge: true }
        );

        transaction.set(
          dailyRef,
          {
            userId: data.userId,
            date: data.date,
            promptsOptimized: admin.firestore.FieldValue.increment(1),
            originalTokens: admin.firestore.FieldValue.increment(data.originalTokens),
            optimizedTokens: admin.firestore.FieldValue.increment(data.optimizedTokens),
            tokensSaved: admin.firestore.FieldValue.increment(data.tokensSaved),
            lastEventAt: data.timestamp
          },
          { merge: true }
        );

        transaction.set(
          monthlyRef,
          {
            userId: data.userId,
            month: data.month,
            promptsOptimized: admin.firestore.FieldValue.increment(1),
            originalTokens: admin.firestore.FieldValue.increment(data.originalTokens),
            optimizedTokens: admin.firestore.FieldValue.increment(data.optimizedTokens),
            tokensSaved: admin.firestore.FieldValue.increment(data.tokensSaved),
            lastEventAt: data.timestamp
          },
          { merge: true }
        );
      });

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error("trackOptimizationEvent failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);

// ---------------------------------------------------------------------------
// getAnalyticsStats — admin-only aggregate stats endpoint
// ---------------------------------------------------------------------------

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function currentMonthUTC() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

// Build a stable label map: sorted user IDs → u1, u2, u3 …
function buildLabelMap(userIds) {
  const sorted = [...userIds].sort();
  const map = {};
  sorted.forEach((id, i) => {
    map[id] = `u${i + 1}`;
  });
  return map;
}

function emptyUserRow(label) {
  return {
    label,
    promptsOptimized: 0,
    originalTokens: 0,
    optimizedTokens: 0,
    tokensSaved: 0,
    reductionPercent: 0
  };
}

// Aggregate an array of Firestore doc data objects keyed by userId
function aggregateByUser(docs) {
  const byUser = {};
  for (const d of docs) {
    const uid = d.userId;
    if (!uid) continue;
    if (!byUser[uid]) {
      byUser[uid] = {
        promptsOptimized: 0,
        originalTokens: 0,
        optimizedTokens: 0,
        tokensSaved: 0,
        reductionCount: 0,
        reductionSum: 0
      };
    }
    const u = byUser[uid];
    u.promptsOptimized += d.promptsOptimized || 0;
    u.originalTokens += d.originalTokens || 0;
    u.optimizedTokens += d.optimizedTokens || 0;
    u.tokensSaved += d.tokensSaved || 0;
    if (d.reductionPercent != null) {
      u.reductionSum += d.reductionPercent;
      u.reductionCount += 1;
    }
  }
  return byUser;
}

exports.getAnalyticsStats = onRequest(
  {
    cors: true,
    region: "us-east1",
    invoker: "public"
  },
  async (req, res) => {
    // Admin key guard
    const expectedKey = process.env.ADMIN_DASHBOARD_KEY;
    if (!expectedKey) {
      return res.status(500).json({ error: "Admin key not configured" });
    }
    const providedKey = req.headers["x-admin-key"];
    if (!providedKey || providedKey !== expectedKey) {
      return res.status(403).json({ error: "Forbidden" });
    }

    try {
      const range = req.query.range || "today";
      const date = req.query.date || todayUTC();
      const month = req.query.month || currentMonthUTC();

      let primaryDocs = [];

      if (range === "today") {
        const snap = await db
          .collection("dailyUserStats")
          .where("date", "==", date)
          .get();
        primaryDocs = snap.docs.map((d) => d.data());
      } else if (range === "month") {
        const snap = await db
          .collection("monthlyUserStats")
          .where("month", "==", month)
          .get();
        primaryDocs = snap.docs.map((d) => d.data());
      } else {
        // all — aggregate across every monthlyUserStats document
        const snap = await db.collection("monthlyUserStats").get();
        primaryDocs = snap.docs.map((d) => d.data());
      }

      // Build per-user aggregates
      const byUser = aggregateByUser(primaryDocs);
      const userIds = Object.keys(byUser);
      const labelMap = buildLabelMap(userIds);

      // Summary totals
      let totalPromptsOptimized = 0;
      let totalOriginalTokens = 0;
      let totalOptimizedTokens = 0;
      let totalTokensSaved = 0;
      let totalCharactersSaved = 0;
      let reductionSum = 0;
      let reductionCount = 0;

      for (const u of Object.values(byUser)) {
        totalPromptsOptimized += u.promptsOptimized;
        totalOriginalTokens += u.originalTokens;
        totalOptimizedTokens += u.optimizedTokens;
        totalTokensSaved += u.tokensSaved;
        reductionSum += u.reductionSum;
        reductionCount += u.reductionCount;
      }

      // charactersSaved lives on optimizationEvents; skip for now (not in stats collections)
      const averageReductionPercent =
        reductionCount > 0
          ? parseFloat((reductionSum / reductionCount).toFixed(2))
          : 0;

      const estimatedEnergyWhSaved = parseFloat(
        (totalTokensSaved * 0.0003).toFixed(4)
      );
      const estimatedWaterMlSaved = parseFloat(
        (totalTokensSaved * 0.05).toFixed(2)
      );

      // Users array (sorted by label → u1, u2, …)
      const users = Object.entries(byUser)
        .map(([uid, u]) => ({
          label: labelMap[uid],
          promptsOptimized: u.promptsOptimized,
          originalTokens: u.originalTokens,
          optimizedTokens: u.optimizedTokens,
          tokensSaved: u.tokensSaved,
          reductionPercent:
            u.reductionCount > 0
              ? parseFloat((u.reductionSum / u.reductionCount).toFixed(2))
              : 0
        }))
        .sort((a, b) => {
          const n = (l) => parseInt(l.slice(1), 10);
          return n(a.label) - n(b.label);
        });

      // Top users by tokens saved
      const topUsersByTokensSaved = [...users]
        .sort((a, b) => b.tokensSaved - a.tokensSaved)
        .slice(0, 10)
        .map(({ label, tokensSaved, promptsOptimized }) => ({
          label,
          tokensSaved,
          promptsOptimized
        }));

      // Daily trend — most recent 31 days from dailyUserStats
      let dailyTrend = [];
      {
        const trendSnap = await db
          .collection("dailyUserStats")
          .orderBy("date", "desc")
          .limit(31 * 50) // over-fetch to cover up to 50 users per day
          .get();

        const byDate = {};
        for (const doc of trendSnap.docs) {
          const d = doc.data();
          if (!d.date) continue;
          if (!byDate[d.date]) byDate[d.date] = { promptsOptimized: 0, tokensSaved: 0 };
          byDate[d.date].promptsOptimized += d.promptsOptimized || 0;
          byDate[d.date].tokensSaved += d.tokensSaved || 0;
        }

        dailyTrend = Object.entries(byDate)
          .map(([dt, v]) => ({ date: dt, ...v }))
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-31);
      }

      // Monthly trend — up to 12 months from monthlyUserStats
      let monthlyTrend = [];
      {
        const trendSnap = await db
          .collection("monthlyUserStats")
          .orderBy("month", "desc")
          .limit(12 * 50)
          .get();

        const byMonth = {};
        for (const doc of trendSnap.docs) {
          const d = doc.data();
          if (!d.month) continue;
          if (!byMonth[d.month]) byMonth[d.month] = { promptsOptimized: 0, tokensSaved: 0 };
          byMonth[d.month].promptsOptimized += d.promptsOptimized || 0;
          byMonth[d.month].tokensSaved += d.tokensSaved || 0;
        }

        monthlyTrend = Object.entries(byMonth)
          .map(([m, v]) => ({ month: m, ...v }))
          .sort((a, b) => a.month.localeCompare(b.month))
          .slice(-12);
      }

      // Total users = all docs in users collection
      const usersSnap = await db.collection("users").get();
      const totalUsers = usersSnap.size;

      return res.status(200).json({
        range,
        date,
        month,
        generatedAt: new Date().toISOString(),
        summary: {
          totalUsers,
          activeUsers: userIds.length,
          totalPromptsOptimized,
          totalOriginalTokens,
          totalOptimizedTokens,
          totalTokensSaved,
          averageReductionPercent,
          totalCharactersSaved,
          estimatedEnergyWhSaved,
          estimatedWaterMlSaved
        },
        users,
        dailyTrend,
        monthlyTrend,
        topUsersByTokensSaved
      });
    } catch (error) {
      console.error("getAnalyticsStats failed:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
);
