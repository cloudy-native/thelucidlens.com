import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { TheLucidLensStack } from "../lib/thelucidlens-stack";

test("defines website and photo buckets, distributions, and OAC", () => {
	const app = new cdk.App();
	app.node.setContext(
		"hosted-zone:account=111111111111:domainName=thelucidlens.com:region=us-east-1",
		{ Id: "/hostedzone/ZTEST", Name: "thelucidlens.com." },
	);

	const stack = new TheLucidLensStack(app, "TestStack", {
		domainName: "thelucidlens.com",
		env: { account: "111111111111", region: "us-east-1" },
	});

	const template = Template.fromStack(stack);

	// Website + photo buckets (both created by the stack)
	template.resourceCountIs("AWS::S3::Bucket", 2);
	template.resourceCountIs("AWS::CloudFront::Distribution", 2);
	template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
	template.resourceCountIs("AWS::CertificateManager::Certificate", 1);

	template.hasResourceProperties("AWS::CertificateManager::Certificate", {
		DomainName: "thelucidlens.com",
		SubjectAlternativeNames: Match.arrayWith([
			"www.thelucidlens.com",
			"photos.thelucidlens.com",
		]),
	});

	// Photo bucket is private (no public access)
	template.hasResourceProperties("AWS::S3::Bucket", {
		PublicAccessBlockConfiguration: {
			BlockPublicAcls: true,
			BlockPublicPolicy: true,
			IgnorePublicAcls: true,
			RestrictPublicBuckets: true,
		},
	});

	template.hasResourceProperties("AWS::Route53::RecordSet", {
		Name: "photos.thelucidlens.com.",
		Type: "A",
	});
});
