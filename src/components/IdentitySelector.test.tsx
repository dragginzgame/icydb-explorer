import { render, screen } from "@testing-library/react";
import { IdentitySelector } from "./IdentitySelector";
import type { IdentityRef } from "../api/types";

const keyring: IdentityRef = { name: "default", algorithm: "secp256k1", kind: "keyring", pemPath: null, unusableReason: null };
const anonymous: IdentityRef = { name: "anonymous", algorithm: "secp256k1", kind: "anonymous", pemPath: null, unusableReason: "the anonymous identity cannot be used: icydb's SQL endpoints are controller-gated" };
const future: IdentityRef = { name: "delegated", algorithm: "secp256k1", kind: "delegation", pemPath: null, unusableReason: "identity kind \"delegation\" is not supported by this app: it cannot be exported as a PEM" };

test("lists every identity, usable or not", () => {
  render(<IdentitySelector identities={[keyring, anonymous, future]} selected="default" onSelect={() => {}} />);
  expect(screen.getByRole("option", { name: /default/ })).toBeDefined();
  expect(screen.getByRole("option", { name: /anonymous/ })).toBeDefined();
  expect(screen.getByRole("option", { name: /delegated/ })).toBeDefined();
});

test("disables identities the app cannot load", () => {
  render(<IdentitySelector identities={[keyring, anonymous]} selected="default" onSelect={() => {}} />);
  expect(screen.getByRole("option", { name: /default/ })).not.toHaveAttribute("disabled");
  expect(screen.getByRole("option", { name: /anonymous/ })).toHaveAttribute("disabled");
});

test("gives the reason an identity is unusable", () => {
  render(<IdentitySelector identities={[keyring, future]} selected="default" onSelect={() => {}} />);
  expect(screen.getByRole("option", { name: /delegation/ })).toBeDefined();
});

test("renders nothing rather than an empty control when there are no identities", () => {
  const { container } = render(<IdentitySelector identities={[]} selected={null} onSelect={() => {}} />);
  expect(container.querySelector("select")).toBeNull();
});
