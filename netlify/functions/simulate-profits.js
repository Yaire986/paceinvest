// netlify/functions/simulate-profits.js
const admin = require('firebase-admin');

// Initialize Firebase Admin
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
} catch (e) {
  console.error('Failed to initialize Firebase Admin:', e);
}
const db = admin.firestore();

// --- CONFIGURATION ---
const PEAK_HOURS_START = 16;
const PEAK_HOURS_END = 22;
const PEAK_HOUR_MULTIPLIER = 1.25;

const PACKAGES = {
  'Standard Port': { sessions: { slow: { chance: 0.2, min: 7.00, max: 11.00 }, standard: { chance: 0.6, min: 11.00, max: 16.00 }, busy: { chance: 0.2, min: 16.00, max: 22.00 }}},
  'High-Traffic Pro Port': { sessions: { slow: { chance: 0.2, min: 12.00, max: 18.00 }, standard: { chance: 0.6, min: 18.00, max: 24.00 }, busy: { chance: 0.2, min: 24.00, max: 32.00 }}}
};

// --- NEW KPI CALCULATION CONSTANTS ---
const REGIONAL_PRICES_PER_KWH = {
    'United States': 0.45, 'Canada': 0.38, 'Mexico': 0.30, 'Puerto Rico': 0.42,
    'Germany': 0.65, 'United Kingdom': 0.58, 'France': 0.52, 'Spain': 0.55, 'Italy': 0.60,
    'Australia': 0.40, 'New Zealand': 0.35, 'Japan': 0.48, 'China': 0.25,
};
const DEFAULT_PRICE_PER_KWH = 0.45; // Fallback price
const CO2_OFFSET_FACTOR_KG_PER_KWH = 0.4; // Average kg of CO2 saved per kWh vs gasoline

// --- HELPER FUNCTIONS ---
const getRandomProfit = (config) => {
  const rand = Math.random(); let cumulativeChance = 0; const sessionTypes = ['slow', 'standard', 'busy'];
  for (const type of sessionTypes) {
    cumulativeChance += config.sessions[type].chance;
    if (rand < cumulativeChance) { const { min, max } = config.sessions[type]; return parseFloat((Math.random() * (max - min) + min).toFixed(2)); }
  }
  const { min, max } = config.sessions.standard; return parseFloat((Math.random() * (max - min) + min).toFixed(2));
};
const getDynamicDescription = (portData, portId) => `Earning from ${portData.locationName || 'Unknown Location'} (${portData.portIdentifier || `#${portId.substring(0,4)}`})`;

// --- MAIN HANDLER ---
exports.handler = async function(event, context) {
  console.log("Starting profit simulation run with KPIs...");
  const currentHour = new Date().getUTCHours();
  const isPeakHour = currentHour >= PEAK_HOURS_START && currentHour <= PEAK_HOURS_END;

  try {
    const portsSnapshot = await db.collectionGroup('ports').where('status', '==', 'Active').get();
    if (portsSnapshot.empty) { return { statusCode: 200, body: "No active ports found." }; }

    const promises = [];
    for (const portDoc of portsSnapshot.docs) {
      const portData = portDoc.data();
      const packageConfig = PACKAGES[portData.package];
      if (!packageConfig) continue;

      // 1. Calculate base profit
      let profit = getRandomProfit(packageConfig);
      if (isPeakHour) { profit = parseFloat((profit * PEAK_HOUR_MULTIPLIER).toFixed(2)); }
      
      // 2. === NEW: Calculate KPIs based on profit ===
      const pricePerKwh = REGIONAL_PRICES_PER_KWH[portData.region] || DEFAULT_PRICE_PER_KWH;
      const kwhDelivered = parseFloat((profit / pricePerKwh).toFixed(2));
      const co2Offset = parseFloat((kwhDelivered * CO2_OFFSET_FACTOR_KG_PER_KWH).toFixed(2));
      const sessions = 1; // Each simulation run counts as one session

      const userId = portDoc.ref.parent.parent.id;
      const portId = portDoc.id;
      
      console.log(`Profit: $${profit}, kWh: ${kwhDelivered} for user ${userId} on port ${portId}`);

      const batch = db.batch();
      const userRef = db.collection('users').doc(userId);

      // 3. === NEW: Update user document with all financial and KPI metrics ===
      batch.update(userRef, {
        availableBalance: admin.firestore.FieldValue.increment(profit),
        monthlyEarnings: admin.firestore.FieldValue.increment(profit),
        lifetimeEarnings: admin.firestore.FieldValue.increment(profit),
        
        monthlyKwhDelivered: admin.firestore.FieldValue.increment(kwhDelivered),
        lifetimeKwhDelivered: admin.firestore.FieldValue.increment(kwhDelivered),
        monthlySessions: admin.firestore.FieldValue.increment(sessions),
        lifetimeSessions: admin.firestore.FieldValue.increment(sessions),
        monthlyCo2Offset: admin.firestore.FieldValue.increment(co2Offset),
        lifetimeCo2Offset: admin.firestore.FieldValue.increment(co2Offset),
      });

      // 4. Update individual port stats (no change here)
      const portRef = userRef.collection('ports').doc(portId);
      batch.update(portRef, {
        lifetimeEarnings: admin.firestore.FieldValue.increment(profit),
        monthlyEarnings: admin.firestore.FieldValue.increment(profit)
      });

      // 5. Create activity log entry (no change here)
      const activityRef = userRef.collection('activity').doc();
      batch.set(activityRef, {
        type: 'earning', amount: profit, description: getDynamicDescription(portData, portId),
        timestamp: admin.firestore.FieldValue.serverTimestamp(), portId: portId
      });

      promises.push(batch.commit());
    }

    await Promise.all(promises);
    const body = `Simulation complete. Processed ${promises.length} transactions with KPIs.`;
    console.log(body);
    return { statusCode: 200, body };

  } catch (error) {
    console.error("Error during KPI profit simulation:", error);
    return { statusCode: 500, body: "An error occurred during simulation." };
  }
};