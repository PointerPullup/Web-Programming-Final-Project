

require("dotenv").config();
const fs = require("fs");
const path = require("path");


const API_KEY = process.env.FMP_API_KEY;
const BASE = "https://financialmodelingprep.com/stable";
const DATA_DIR = path.join(__dirname, "data");
const REQUEST_DELAY = 250;   
const MAX_RETRY = 3;         
const REFRESH = process.argv.includes("--refresh");


const COMPANIES = [
    { name: "NVIDIA",    ticker: "NVDA" },
    { name: "Alphabet",  ticker: "GOOGL" },
    { name: "Apple",     ticker: "AAPL" },
    { name: "Microsoft", ticker: "MSFT" },
    { name: "Meta",      ticker: "META" },
    { name: "Tesla",     ticker: "TSLA" },
    { name: "TSMC",      ticker: "TSM" },   
    { name: "IonQ",      ticker: "IONQ" },
    { name: "SpaceX",    ticker: "SPCX" }   
];


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
}


function round2(v) {
    const n = num(v);
    return n === null ? null : Math.round(n * 100) / 100;
}


function toPercent(v) {
    const n = num(v);
    return n === null ? null : Math.round(n * 10000) / 100;
}


function pick(obj, keys) {
    if (!obj) return undefined;
    for (const k of keys) {
        if (obj[k] !== null && obj[k] !== undefined) return obj[k];
    }
    return undefined;
}


function fmtDate(d) {
    return d.toISOString().slice(0, 10);
}


function today() {
    return fmtDate(new Date());
}
function threeYearsAgo() {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 3);
    return fmtDate(d);
}


async function fetchJson(url, label) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        try {
            const res = await fetch(url);
            
            if (res.status === 402) throw new Error("미지원(402, 유료 전용)");
            if (res.status === 429) throw new Error("rate limit (429)");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            lastErr = e;
            if (e.message.includes("402")) throw e; 
            const wait = REQUEST_DELAY * Math.pow(2, attempt); 
            console.warn(`    ↻ ${label} 실패 (${e.message}) → ${wait}ms 후 재시도 ${attempt + 1}/${MAX_RETRY}`);
            await sleep(wait);
        }
    }
    throw lastErr;
}


async function safeCall(url, label) {
    try {
        return await callApi(url, label);
    } catch (e) {
        console.warn(`    ⚠ ${label} 실패 (${e.message}) → 데이터 없음 처리`);
        return null;
    }
}


async function callApi(url, label) {
    const data = await fetchJson(url, label);
    await sleep(REQUEST_DELAY);
    return data;
}


function extractRows(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.historical)) return data.historical;
    return [];
}

function downsampleMonthly(rows) {
    const byMonth = new Map(); 
    for (const r of rows) {
        if (!r || !r.date) continue;
        const price = num(r.price ?? r.close ?? r.adjClose);
        if (price === null) continue;
        const month = r.date.slice(0, 7);
        const prev = byMonth.get(month);
        if (!prev || r.date > prev.date) {
            byMonth.set(month, { date: r.date, price });
        }
    }
    return [...byMonth.values()]
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((p) => ({ date: p.date, price: Math.round(p.price * 100) / 100 }));
}


function readExisting(ticker) {
    const file = path.join(DATA_DIR, `${ticker.toLowerCase()}.json`);
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
        return null;
    }
}


async function processCompany(company) {
    const { name, ticker } = company;
    const T = encodeURIComponent(ticker);
    console.log(`\n▶ ${name} (${ticker})`);

    const existing = REFRESH ? null : readExisting(ticker);
    const missing = []; 

    
    const quoteArr = await safeCall(`${BASE}/quote?symbol=${T}&apikey=${API_KEY}`, "quote");
    const quote = Array.isArray(quoteArr) ? quoteArr[0] : quoteArr;

    const marketCap = num(pick(quote, ["marketCap", "marketCapitalization"]));
    const price     = round2(pick(quote, ["price"]));
    if (marketCap === null) missing.push("marketCap");
    if (price === null) missing.push("price");

    
    const ratiosArr = await safeCall(`${BASE}/ratios-ttm?symbol=${T}&apikey=${API_KEY}`, "ratios-ttm");
    const ratios = Array.isArray(ratiosArr) ? ratiosArr[0] : ratiosArr;

    
    const per = round2(pick(quote, ["pe", "peRatio"]) ?? pick(ratios, ["priceToEarningsRatioTTM", "priceToEarningsRatio"]));
    const pbr = round2(pick(ratios, ["priceToBookRatioTTM", "priceToBookRatio", "pbRatioTTM"]));

    
    let roe = toPercent(pick(ratios, ["returnOnEquityTTM", "returnOnEquity"]));
    if (roe === null) {
        const niPerShare = num(pick(ratios, ["netIncomePerShareTTM", "netIncomePerShare"]));
        const eqPerShare = num(pick(ratios, ["shareholdersEquityPerShareTTM", "bookValuePerShareTTM"]));
        if (niPerShare !== null && eqPerShare && eqPerShare !== 0) {
            roe = Math.round((niPerShare / eqPerShare) * 10000) / 100;
        }
    }

    if (per === null) missing.push("per(PER)");
    if (pbr === null) missing.push("pbr(PBR)");
    if (roe === null) missing.push("roe(ROE)");

    
    const growthArr = await safeCall(`${BASE}/financial-growth?symbol=${T}&apikey=${API_KEY}`, "financial-growth");
    const growth = Array.isArray(growthArr) ? growthArr[0] : growthArr;

    const revenueGrowthYoY = toPercent(pick(growth, ["revenueGrowth", "growthRevenue"]));
    if (revenueGrowthYoY === null) missing.push("revenueGrowthYoY");

    
    const oldMonthly = existing && Array.isArray(existing.monthlyPrices) ? existing.monthlyPrices : [];

    
    let from;
    if (oldMonthly.length > 0) {
        const lastDate = oldMonthly[oldMonthly.length - 1].date; 
        from = lastDate.slice(0, 7) + "-01";                     
    } else {
        from = threeYearsAgo();
    }
    const to = today();

    const histData = await safeCall(
        `${BASE}/historical-price-eod/light?symbol=${T}&from=${from}&to=${to}&apikey=${API_KEY}`,
        "historical-price-eod/light"
    );
    const newMonthly = downsampleMonthly(extractRows(histData));
    if (newMonthly.length === 0) missing.push("monthlyPrices(주가 이력)");

    
    const fromMonth = from.slice(0, 7);
    const kept = oldMonthly.filter((p) => p.date.slice(0, 7) < fromMonth);
    const monthlyPrices = [...kept, ...newMonthly];

    
    if (missing.length > 0) {
        console.warn(`    ⚠ 누락(null로 저장): ${missing.join(", ")}`);
    }

    
    const result = {
        symbol: ticker,
        name,
        metrics: {
            marketCap,           
            price,               
            per,                 
            pbr,                 
            roe,                 
            revenueGrowthYoY     
        },
        monthlyPrices,           
        
        unavailable: missing.length > 0 ? missing : [],
        dataStatus: missing.length > 0 ? `데이터 없음: ${missing.join(", ")}` : "정상",
        updatedAt: new Date().toISOString()
    };

    const file = path.join(DATA_DIR, `${ticker.toLowerCase()}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2), "utf-8");
    console.log(`    ✔ 저장: data/${ticker.toLowerCase()}.json (월별 ${monthlyPrices.length}개${REFRESH ? ", 전체 재수집" : oldMonthly.length ? ", 증분" : ""})`);
}


async function main() {
    if (!API_KEY) {
        console.error("✗ 환경변수 FMP_API_KEY 가 없습니다.");
        console.error("  .env.example 을 복사해 .env 를 만들고 발급받은 키를 넣어주세요.");
        process.exit(1);
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });

    console.log(`FMP 데이터 수집 시작 (${COMPANIES.length}개 기업)${REFRESH ? " — 전체 강제 재수집" : ""}`);

    let ok = 0;
    let fail = 0;
    for (const company of COMPANIES) {
        try {
            await processCompany(company);
            ok++;
        } catch (e) {
            
            fail++;
            console.error(`    ✗ ${company.name} (${company.ticker}) 처리 실패: ${e.message}`);
        }
    }

    console.log(`\n완료 — 성공 ${ok}개 / 실패 ${fail}개`);
}

main();
