import { NextRequest } from "next/server";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN!;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const CLS_LOCATION_ID = process.env.SHOPIFY_CLS_LOCATION_ID!;
const RECONCILE_SECRET = process.env.RECONCILE_SECRET!;

async function shopifyGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(
    `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": TOKEN,
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

async function getAllVariantsWithInventory() {
  type Resp = {
    productVariants: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          inventoryItem: {
            id: string;
            inventoryLevels: {
              edges: Array<{
                node: {
                  location: { id: string };
                  quantities: Array<{
                    name: string;
                    quantity: number;
                  }>;
                };
              }>;
            };
          };
        };
      }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string;
      };
    };
  };

  const query = `
    query GetVariants($cursor: String) {
      productVariants(first: 50, after: $cursor) {
        edges {
          node {
            id
            title
            inventoryItem {
              id
              inventoryLevels(first: 10) {
                edges {
                  node {
                    location { id }
                    quantities(names: ["available"]) {
                      name
                      quantity
                    }
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const allVariants = [];
  let cursor: string | null = null;

  while (true) {
    const data = await shopifyGraphQL<Resp>(query, { cursor });
    const { edges, pageInfo } = data.productVariants;
    allVariants.push(...edges.map((e) => e.node));
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return allVariants;
}

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
          key: "cls_qty",
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

export async function GET(request: NextRequest) {
  // Protect the route with a secret so it can't be triggered publicly
  const secret = request.nextUrl.searchParams.get("secret");
  if (secret !== RECONCILE_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const clsGid = `gid://shopify/Location/${CLS_LOCATION_ID}`;
    const variants = await getAllVariantsWithInventory();

    const results = { updated: 0, skipped: 0, errors: 0 };

    for (const variant of variants) {
      try {
        const clsLevel = variant.inventoryItem.inventoryLevels.edges.find(
          (e) => e.node.location.id === clsGid
        );

        // No CLS inventory level found for this variant — skip
        if (!clsLevel) {
          results.skipped++;
          continue;
        }

        const available =
          clsLevel.node.quantities.find((q) => q.name === "available")
            ?.quantity ?? 0;

        const value = available === 0 ? "outofstock" : "instock";
        await setClsQtyMetafield(variant.id, value);
        results.updated++;
      } catch (err) {
        console.error("Error updating variant:", variant.id, err);
        results.errors++;
      }
    }

    console.log("Reconciliation complete:", results);
    return Response.json({ ok: true, results });
  } catch (error) {
    console.error("Reconciliation error:", error);
    return new Response("Server error", { status: 500 });
  }
}