import crypto from "node:crypto";
import { URLSearchParams } from "node:url";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET!;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const CLS_LOCATION_ID = process.env.SHOPIFY_CLS_LOCATION_ID!;

// Token cache
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

type InventoryWebhookPayload = {
  inventory_item_id: number;
  location_id: number;
  available?: number | null;
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const res = await fetch(
    `https://${SHOP}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    }
  );

  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);

  const { access_token, expires_in } = await res.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;

  return cachedToken!;
}

// ─── Webhook verification ─────────────────────────────────────────────────────

function verifyWebhook(rawBody: string, hmacHeader: string | null): boolean {
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── GraphQL ──────────────────────────────────────────────────────────────────

async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = await getAccessToken();

  const res = await fetch(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(JSON.stringify(json, null, 2));
  }
  return json.data as T;
}

// ─── Variant lookup ───────────────────────────────────────────────────────────

async function getVariantByInventoryItemId(inventoryItemId: number) {
  type Resp = {
    productVariants: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          product: { status: string };
        };
      }>;
    };
  };

  const data = await shopifyGraphQL<Resp>(
    `query GetVariant($q: String!) {
      productVariants(first: 1, query: $q) {
        edges {
          node {
            id
            title
            product {
              status
            }
          }
        }
      }
    }`,
    { q: `inventory_item_id:${inventoryItemId}` }
  );

  const variant = data.productVariants.edges[0]?.node;

  if (!variant || variant.product.status !== "ACTIVE") {
    return null;
  }

  return variant;
}

// ─── Metafield update ─────────────────────────────────────────────────────────

async function setClsQtyMetafield(variantId: string, value: string) {
  type Resp = {
    metafieldsSet: {
      metafields: Array<{ id: string; value: string }>;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  };

  const data = await shopifyGraphQL<Resp>(
    `mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id value }
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: variantId,
          namespace: "custom",
          key: "international_availability",
          type: "single_line_text_field",
          value,
        },
      ],
    }
  );

  if (data.metafieldsSet.userErrors.length) {
    throw new Error(JSON.stringify(data.metafieldsSet.userErrors, null, 2));
  }

  return data.metafieldsSet.metafields[0];
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const hmacHeader = request.headers.get("x-shopify-hmac-sha256");

    // TEMP: log env vars to debug (lengths only, not values)
    console.log("ENV CHECK:", {
      shop: SHOP,
      clientIdLength: CLIENT_ID?.length,
      clientSecretLength: CLIENT_SECRET?.length,
      clsLocationId: CLS_LOCATION_ID,
      hmacHeader,
    });

    // TEMP: HMAC verification disabled for testing
    // if (!verifyWebhook(rawBody, hmacHeader)) {
    //   console.error("Invalid webhook signature");
    //   return new Response("Unauthorized", { status: 401 });
    // }

    const payload = JSON.parse(rawBody) as InventoryWebhookPayload;
    const locationId = String(payload.location_id);
    const inventoryItemId = payload.inventory_item_id;
    const available = Number(payload.available ?? 0);

    console.log("Webhook received:", { locationId, inventoryItemId, available });

    if (locationId !== String(CLS_LOCATION_ID)) {
      console.log("Ignored — not CLS location:", locationId);
      return new Response("Ignored non-CLS location", { status: 200 });
    }

    if (available !== 0) {
      console.log("Ignored — inventory not zero:", available);
      return new Response("Ignored non-zero inventory", { status: 200 });
    }

    const variant = await getVariantByInventoryItemId(inventoryItemId);
    if (!variant) {
      console.log("Skipped — variant not found or product not active:", inventoryItemId);
      return new Response("Variant not found or product not active", { status: 200 });
    }

    const metafield = await setClsQtyMetafield(variant.id, "outofstock-international");
    console.log("Updated metafield:", metafield);

    return new Response("CLS metafield updated", { status: 200 });
  } catch (error) {
    console.error("Webhook error:", error);
    return new Response("Server error", { status: 500 });
  }
}