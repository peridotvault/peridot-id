import { generateUsername, sanitizeUsernameBase, USERNAME_REGEX } from "./username";

function client(taken: string[]) {
  const takenSet = new Set(taken);
  return {
    profile: {
      findUnique: jest.fn(async ({ where }: { where: { username: string } }) =>
        takenSet.has(where.username) ? { id: "x" } : null,
      ),
    },
  };
}

describe("sanitizeUsernameBase", () => {
  it("takes the first word, lowercases and strips non-alphanumeric characters", () => {
    expect(sanitizeUsernameBase("Ranaufal Muha")).toBe("ranaufal");
    expect(sanitizeUsernameBase("Foo! Bar")).toBe("foo");
  });

  it("falls back to 'user' when too short or empty", () => {
    expect(sanitizeUsernameBase(null)).toBe("user");
    expect(sanitizeUsernameBase("A!")).toBe("user");
  });
});

describe("generateUsername", () => {
  it("uses the base when free", async () => {
    expect(await generateUsername(client([]), "Ranaufal Muha")).toBe("ranaufal");
  });

  it("appends a random suffix when the base is taken", async () => {
    const username = await generateUsername(client(["ranaufal"]), "Ranaufal Muha");
    expect(username).toMatch(USERNAME_REGEX);
    expect(username.startsWith("ranaufal_")).toBe(true);
    expect(username).not.toBe("ranaufal");
  });
});
