#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { TheLucidLensStack } from "../lib/thelucidlens-stack";

const app = new App();

const domainName = "thelucidlens.com";

const tags = {
	Project: "thelucidlens.com",
	Environment: "production",
	Author: "stephen",
};

new TheLucidLensStack(app, "TheLucidLensStack", {
	domainName,
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: process.env.CDK_DEFAULT_REGION,
	},
	tags,
	description: "thelucidlens.com — static site + portfolio photo CDN",
});
