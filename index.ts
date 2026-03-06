/**
 * ============================================================
 *  IMPORTADOR DE PRODUCTOS DESDE EXCEL → MySQL
 *
 *  Instalar dependencias:
 *    bun add mysql2 xlsx
 *
 *  Ejecutar:
 *    bun run import-products.ts
 *
 *  El archivo Excel (.xls) debe estar al lado de este script.
 * ============================================================
 */

import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import * as XLSX from "xlsx";

// ================================================================
//  ⚙️  CONFIGURACIÓN — Edita estos valores antes de ejecutar
// ================================================================
const CONFIG = {
  /** ID de la empresa en la tabla `companies` */
  COMPANY_ID: 11,

  /** ID de la sucursal principal en `branches` */
  BRANCH_ID: 11,

  /**
   * Otras sucursales que compartirán el mismo catálogo.
   * Se crearán Presentations duplicadas para cada una,
   * permitiendo que el mismo ProductFamily se use en varias sucursales.
   */
  EXTRA_BRANCH_IDS: [] as number[], // ej: [2, 3, 4]

  /** Nombre del archivo Excel (debe estar junto a este script) */
  EXCEL_FILE: "./products.xls",

  /**
   * Si true, omite productos cuyo nombre ya existe en product_family
   * para la misma empresa. Útil para reimportar sin duplicar.
   */
  SKIP_EXISTING: true,

  /** Conexión MySQL */
  DB: {
    host: "147.79.78.220",
    port: 3306,
    user: "root",
    password: "!d*dR4*BOi744!",
    database: "demos_elemental",
  },
};
// ================================================================

// ================================================================
//  📋  CLASIFICACIÓN DE COLUMNAS DEL EXCEL
// ================================================================

/**
 * PRICE_SCALE_COLUMNS → tabla `price_scales`
 * Son precios fijos por tipo de cliente / canal de distribución.
 * Campos: name (string), price, presentation_id
 */
const PRICE_SCALE_COLUMNS: string[] = [
  "CLIENTE FRECUENTE",
  "CLIENTE FRECUENTE 5",
  "CLIENTE PREFERENCIAL 1",
  "CLIENTE PREFERENCIAL 2",
  "Copa Ghorse parafina",
  "DETALLE",
  "DISTRIBUICION 1",
  "DISTRIBUICION 2",
  "Escala 4",
  "MANTIENE PRECIO EN ESCALA",
  "MAYORISTA",
  "MEDIO FARDO 1",
  "MEDIO FARDO 2",
  "MINORISTA",
  "PRECIO CAJA 1",
  "PRECIO CAJA 2",
  "SEMI MAYORISTA",
  "SUPER 2",
  "SUPER 3",
  "SUPER MAYORISTA",
];

/**
 * PRICE_RULE_COLUMNS → tabla `price_rules`
 * Son precios que se activan cuando el cliente lleva X unidades o más.
 * Campos: presentation_id, product_family_id, selling_price,
 *         percentage, diff_price, value_unit, greater_than
 *
 * Mapa: { nombreColumnaExcel → greaterThan }
 */
const PRICE_RULE_COLUMNS: Record<string, number> = {
  "SI LEVA 30": 30,
  "si lleva 10": 10,
  "SI LLEVA 12": 12,
  "SI LLEVA 15": 15,
  "SI LLEVA 16": 16,
  "SI LLEVA 20": 20,
  "SI LLEVA 24": 24,
  "SI LLEVA 25": 25,
  "SI LLEVA 3": 3,
  "SI LLEVA 32": 32,
  "SI LLEVA 4": 4,
  "SI LLEVA 40": 40,
  "SI LLEVA 48": 48,
  "SI LLEVA 5": 5,
  "SI LLEVA 50": 50,
  "SI LLEVA 6": 6,
  "SI LLEVA 8": 8,
  "SI LLEVA 96": 96,
  "FARDO 28": 28,
  "FDO 48U": 48,
  "PRECIO CAJA 60U": 60,
};

// ================================================================
//  🏗️  TIPOS INTERNOS
// ================================================================

interface PriceScaleEntry {
  name: string;
  price: number;
}

interface PriceRuleEntry {
  columnName: string; // nombre original para trazabilidad
  greaterThan: number;
  sellingPrice: number;
  percentage: number; // (scalePrice - pv1) / pv1 * 100
  diffPrice: number; // scalePrice - pv1 (negativo = descuento)
  valueUnit: number; // umu de la presentación
}

interface ParsedPresentation {
  name: string; // "Unidad", "Caja 60 U.", etc.
  umu: number; // cantidad base (1, 60, …)
  purchasePrice: number;
  sellingPrice: number;
  priceScales: PriceScaleEntry[];
  priceRules: PriceRuleEntry[];
}

interface ParsedProduct {
  name: string;
  presentations: ParsedPresentation[];
}

type ColMeta =
  | { type: "core"; key: string }
  | { type: "scale"; canonicalName: string }
  | { type: "rule"; canonicalName: string; greaterThan: number };

// ================================================================
//  🔧  UTILIDADES
// ================================================================

function toNumber(val: unknown): number {
  if (val === null || val === undefined || val === "") return 0;
  const n = parseFloat(String(val).replace(",", "."));
  return isNaN(n) ? 0 : n;
}

function normHeader(h: string): string {
  return String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function calcPercentage(scalePrice: number, basePrice: number): number {
  if (basePrice === 0) return 0;
  return parseFloat((((scalePrice - basePrice) / basePrice) * 100).toFixed(4));
}

function calcDiff(scalePrice: number, basePrice: number): number {
  return parseFloat((scalePrice - basePrice).toFixed(4));
}

// ================================================================
//  📂  LECTURA DEL EXCEL
// ================================================================

function readExcel(filePath: string): ParsedProduct[] {
  console.log(`\n📂 Leyendo archivo: ${filePath}`);

  const workbook = XLSX.readFile(filePath, {
    type: "file",
    cellText: false,
    cellDates: true,
    raw: true,
  });

  const sheetName = workbook.SheetNames[0];
  console.log(`   Hoja activa: "${sheetName}"`);

  const sheet = workbook.Sheets[sheetName || ""]!;
  const rawRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, {
    defval: 0,
    raw: true,
  });

  if (rawRows.length === 0) throw new Error("El archivo Excel está vacío.");

  // ---- Mapear headers ----
  const allExcelHeaders = Object.keys(rawRows?.[0] || {});
  const colMeta = new Map<string, ColMeta>();
  const CORE_KEYS = ["producto", "um", "umu", "costo", "pv1"];

  for (const header of allExcelHeaders) {
    const norm = normHeader(header);

    const coreKey = CORE_KEYS.find((k) => k === norm);
    if (coreKey) {
      colMeta.set(header, { type: "core", key: coreKey });
      continue;
    }

    const scaleMatch = PRICE_SCALE_COLUMNS.find((s) => normHeader(s) === norm);
    if (scaleMatch) {
      colMeta.set(header, { type: "scale", canonicalName: scaleMatch });
      continue;
    }

    for (const [ruleName, gt] of Object.entries(PRICE_RULE_COLUMNS)) {
      if (normHeader(ruleName) === norm) {
        colMeta.set(header, {
          type: "rule",
          canonicalName: ruleName,
          greaterThan: gt,
        });
        break;
      }
    }
  }

  const coreCount = [...colMeta.values()].filter(
    (m) => m.type === "core",
  ).length;
  const scaleCount = [...colMeta.values()].filter(
    (m) => m.type === "scale",
  ).length;
  const ruleCount = [...colMeta.values()].filter(
    (m) => m.type === "rule",
  ).length;

  console.log(`   Total filas           : ${rawRows.length}`);
  console.log(`   Columnas core         : ${coreCount}`);
  console.log(`   Columnas PriceScale   : ${scaleCount}`);
  console.log(`   Columnas PriceRule    : ${ruleCount}`);
  console.log(
    `   Columnas sin mapear   : ${allExcelHeaders.length - colMeta.size}`,
  );

  // Helper para acceder a valores core
  function getCoreValue(row: Record<string, unknown>, key: string): unknown {
    for (const [header, meta] of colMeta) {
      if (meta.type === "core" && meta.key === key) return row[header];
    }
    return undefined;
  }

  // Filtrar filas con nombre de producto
  const validRows = rawRows.filter((row) => {
    const val = getCoreValue(row, "producto");
    const s = String(val ?? "").trim();
    return s !== "" && s !== "0";
  });

  console.log(`   Filas válidas         : ${validRows.length}`);

  // Agrupar por nombre de producto
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of validRows) {
    const name = String(getCoreValue(row, "producto") ?? "").trim();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(row);
  }

  // Construir productos parseados
  const products: ParsedProduct[] = [];

  for (const [productName, rows] of groups) {
    const presentations: ParsedPresentation[] = [];

    for (const row of rows) {
      const um = String(getCoreValue(row, "um") ?? "Unidad").trim() || "Unidad";
      const umu = Math.max(1, Math.round(toNumber(getCoreValue(row, "umu"))));
      const costo = toNumber(getCoreValue(row, "costo"));
      const pv1 = toNumber(getCoreValue(row, "pv1"));

      const priceScales: PriceScaleEntry[] = [];
      const priceRules: PriceRuleEntry[] = [];

      for (const [header, meta] of colMeta) {
        const price = toNumber(row[header]);
        if (price <= 0) continue;

        if (meta.type === "scale") {
          priceScales.push({ name: meta.canonicalName, price });
        } else if (meta.type === "rule") {
          priceRules.push({
            columnName: meta.canonicalName,
            greaterThan: meta.greaterThan,
            sellingPrice: price,
            percentage: calcPercentage(price, pv1),
            diffPrice: calcDiff(price, pv1),
            valueUnit: umu,
          });
        }
      }

      presentations.push({
        name: um,
        umu,
        purchasePrice: costo,
        sellingPrice: pv1,
        priceScales,
        priceRules,
      });
    }

    if (presentations.length > 0) {
      products.push({ name: productName, presentations });
    }
  }

  console.log(`   Productos únicos      : ${products.length}\n`);
  return products;
}

// ================================================================
//  💾  OPERACIONES DE BASE DE DATOS
// ================================================================

/**
 * Inserta un product_family y retorna su ID.
 */
async function createProductFamily(
  db: Connection,
  name: string,
): Promise<number> {
  const [res] = await db.execute<ResultSetHeader>(
    `INSERT INTO product_family (name, companyId, created_at)
     VALUES (?, ?, NOW())`,
    [name, CONFIG.COMPANY_ID],
  );
  return res.insertId;
}

/**
 * Inserta un product (registro único a nivel empresa) y retorna su ID.
 * El precio base se hereda de la presentación de menor umu (la "unidad").
 */
async function createProduct(
  db: Connection,
  name: string,
  familyId: number,
  purchasePrice: number,
  sellingPrice: number,
): Promise<number> {
  const [res] = await db.execute<ResultSetHeader>(
    `INSERT INTO products
       (name, product_family_id, companyId, branch_id,
        purchase_price, selling_price,
        is_active, show_in_ecommerce,
        use_stock, have_iva_in_price, reserved,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 1, 0, NOW())`,
    [
      name,
      familyId,
      CONFIG.COMPANY_ID,
      CONFIG.BRANCH_ID,
      purchasePrice,
      sellingPrice,
    ],
  );
  return res.insertId;
}

/**
 * Inserta una presentation vinculada a una sucursal y retorna su ID.
 * Se crea una presentation por cada (tipo de presentación × sucursal).
 */
async function createPresentation(
  db: Connection,
  pres: ParsedPresentation,
  familyId: number,
  branchId: number,
  isDefault: boolean,
): Promise<number> {
  const [res] = await db.execute<ResultSetHeader>(
    `INSERT INTO presentations
       (name, value, value_unit, stock,
        selling_price, purchase_price,
        product_family_id, branch_id,
        is_active, is_default, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, ?, NOW())`,
    [
      pres.name,
      pres.umu,
      pres.umu,
      pres.sellingPrice,
      pres.purchasePrice,
      familyId,
      branchId,
      isDefault ? 1 : 0,
    ],
  );
  return res.insertId;
}

/**
 * Inserta en batch todas las PriceScales de una presentación.
 *
 * price_scales:
 *   name           → nombre del tipo de cliente (MAYORISTA, MINORISTA, …)
 *   price          → precio para ese tipo de cliente
 *   commission     → NULL (no se tiene en el Excel)
 *   margin         → NULL (no se tiene en el Excel)
 *   presentation_id → FK a presentations
 */
async function createPriceScales(
  db: Connection,
  scales: PriceScaleEntry[],
  presentationId: number,
): Promise<number> {
  if (scales.length === 0) return 0;

  const placeholders = scales
    .map(() => "(?, ?, ?, NULL, NULL, NOW())")
    .join(", ");
  const values: any[] = [];
  for (const s of scales) {
    values.push(s.name, s.price, presentationId);
  }

  await db.execute(
    `INSERT INTO price_scales
       (name, price, presentation_id, commission, margin, created_at)
     VALUES ${placeholders}`,
    values,
  );

  return scales.length;
}

/**
 * Inserta en batch todas las PriceRules de una presentación.
 *
 * price_rules:
 *   presentation_id   → FK a presentations
 *   product_family_id → FK a product_family (para consulta rápida por familia)
 *   selling_price     → precio cuando se cumple la regla
 *   percentage        → % de variación respecto al precio base (pv1)
 *   diff_price        → diferencia absoluta respecto al precio base
 *   value_unit        → umu de la presentación
 *   greater_than      → cantidad mínima para activar la regla (el X de "SI LLEVA X")
 */
async function createPriceRules(
  db: Connection,
  rules: PriceRuleEntry[],
  presentationId: number,
  productFamilyId: number,
): Promise<number> {
  if (rules.length === 0) return 0;

  const placeholders = rules
    .map(() => "(?, ?, ?, ?, ?, ?, ?, NOW())")
    .join(", ");
  const values: any[] = [];

  for (const r of rules) {
    values.push(
      presentationId,
      productFamilyId,
      r.sellingPrice,
      r.percentage,
      r.diffPrice,
      r.valueUnit,
      r.greaterThan,
    );
  }

  await db.execute(
    `INSERT INTO price_rules
       (presentation_id, product_family_id,
        selling_price, percentage, diff_price,
        value_unit, greater_than, created_at)
     VALUES ${placeholders}`,
    values,
  );

  return rules.length;
}

// ================================================================
//  🚀  MAIN
// ================================================================

async function main() {
  console.log("=".repeat(65));
  console.log("  IMPORTADOR DE PRODUCTOS — Bun + MySQL");
  console.log("=".repeat(65));
  console.log(`  Empresa ID       : ${CONFIG.COMPANY_ID}`);
  console.log(`  Sucursal ID      : ${CONFIG.BRANCH_ID}`);
  console.log(
    `  Sucursales extra : ${
      CONFIG.EXTRA_BRANCH_IDS.length > 0
        ? CONFIG.EXTRA_BRANCH_IDS.join(", ")
        : "ninguna"
    }`,
  );
  console.log(`  Skip existentes  : ${CONFIG.SKIP_EXISTING}`);
  console.log("=".repeat(65));

  // ── 1. Leer Excel ────────────────────────────────────────────
  const products = readExcel(CONFIG.EXCEL_FILE);

  // ── 2. Conectar MySQL ─────────────────────────────────────────
  const db = await mysql.createConnection(CONFIG.DB as mysql.ConnectionOptions);
  console.log(`✅ Conexión MySQL establecida.\n`);

  const allBranchIds = [CONFIG.BRANCH_ID, ...CONFIG.EXTRA_BRANCH_IDS];

  // Contadores
  let okProducts = 0;
  let skipped = 0;
  let okPresentations = 0;
  let okScales = 0;
  let okRules = 0;
  const errors: string[] = [];

  try {
    // Cargar nombres existentes si se quiere evitar duplicados
    let existingNames = new Set<string>();
    if (CONFIG.SKIP_EXISTING) {
      const [rows] = await db.execute<RowDataPacket[]>(
        `SELECT name FROM product_family
         WHERE companyId = ? AND deleted_at IS NULL`,
        [CONFIG.COMPANY_ID],
      );
      existingNames = new Set(rows.map((r) => String(r.name).trim()));
      console.log(`ℹ️  Familias ya existentes en DB: ${existingNames.size}`);
    }

    await db.execute("START TRANSACTION");

    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      // Progreso en consola
      if ((i + 1) % 250 === 0 || i + 1 === products.length) {
        process.stdout.write(
          `\r   Procesando ${i + 1} / ${products.length}...   `,
        );
      }

      // Saltar si ya existe
      if (CONFIG.SKIP_EXISTING && existingNames.has(product!.name)) {
        skipped++;
        continue;
      }

      try {
        // ── A. ProductFamily ──────────────────────────────────────
        const familyId = await createProductFamily(db, product!.name);

        // ── B. Product ────────────────────────────────────────────
        // Precio base = presentación más pequeña (umu = 1 si existe)
        const basePresentation =
          product!.presentations.find((p) => p.umu === 1) ??
          product!.presentations.reduce((a, b) => (a.umu < b.umu ? a : b));

        await createProduct(
          db,
          product!.name,
          familyId,
          basePresentation.purchasePrice,
          basePresentation.sellingPrice,
        );

        // ── C. Presentations + Escalas + Reglas ───────────────────
        // Iteramos por cada presentación y por cada sucursal destino.
        // Esto garantiza que el mismo ProductFamily esté disponible
        // en múltiples sucursales con sus propias Presentations.
        for (const pres of product!.presentations) {
          const isDefault = pres.umu === basePresentation.umu;

          for (const branchId of allBranchIds) {
            // Crear presentation para esta sucursal
            const presId = await createPresentation(
              db,
              pres,
              familyId,
              branchId,
              isDefault,
            );
            okPresentations++;

            // PriceScales (MAYORISTA, MINORISTA, DISTRIBUICION 1…)
            okScales += await createPriceScales(db, pres.priceScales, presId);

            // PriceRules (SI LLEVA 10, SI LLEVA 25, FARDO 28…)
            // Se vinculan tanto a la presentation como a la productFamily
            // para que puedan consultarse de ambas formas.
            okRules += await createPriceRules(
              db,
              pres.priceRules,
              presId,
              familyId,
            );
          }
        }

        okProducts++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`❌ [${product!.name}] ${msg}`);
        // El error es por producto individual, no detiene la transacción.
        // Si prefieres detener todo al primer error, lanza aquí: throw err
      }
    }

    await db.execute("COMMIT");
  } catch (fatalErr) {
    await db.execute("ROLLBACK");
    console.error("\n\n💥 Error FATAL — ROLLBACK completo.");
    console.error(fatalErr);
    await db.end();
    process.exit(1);
  }

  await db.end();

  // ── Resumen ───────────────────────────────────────────────────
  console.log("\n\n" + "=".repeat(65));
  console.log("  RESUMEN DE IMPORTACIÓN");
  console.log("=".repeat(65));
  console.log(`  ✅ Productos importados       : ${okProducts}`);
  console.log(`  ⏭️  Productos omitidos (exist) : ${skipped}`);
  console.log(`  📦 Presentations creadas     : ${okPresentations}`);
  console.log(`  💲 PriceScales (por nombre)  : ${okScales}`);
  console.log(`  📏 PriceRules  (por cantidad): ${okRules}`);

  if (errors.length > 0) {
    console.log(`\n  ⚠️  Errores (${errors.length}):`);
    errors.slice(0, 30).forEach((e) => console.log(`    ${e}`));
    if (errors.length > 30) console.log(`    ... y ${errors.length - 30} más`);
  } else {
    console.log(`\n  🎉 Importación sin errores.`);
  }

  console.log("=".repeat(65));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
