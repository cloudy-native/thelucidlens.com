import {
	CfnOutput,
	Duration,
	RemovalPolicy,
	Stack,
	type StackProps,
} from "aws-cdk-lib";
import {
	Certificate,
	CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import {
	AllowedMethods,
	CacheCookieBehavior,
	CacheHeaderBehavior,
	CachePolicy,
	CacheQueryStringBehavior,
	CachedMethods,
	Distribution,
	ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import {
	S3BucketOrigin,
	S3StaticWebsiteOrigin,
} from "aws-cdk-lib/aws-cloudfront-origins";
import { ARecord, HostedZone, RecordTarget } from "aws-cdk-lib/aws-route53";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";
import {
	BlockPublicAccess,
	Bucket,
	BucketEncryption,
	HttpMethods,
	ObjectOwnership,
} from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";

export interface TheLucidLensStackProps extends StackProps {
	/** Apex domain, e.g. thelucidlens.com */
	domainName: string;
}

export class TheLucidLensStack extends Stack {
	constructor(scope: Construct, id: string, props: TheLucidLensStackProps) {
		super(scope, id, props);

		const { domainName } = props;
		const wwwDomain = `www.${domainName}`;
		const photosDomain = `photos.${domainName}`;

		// ── Website assets (Astro build output) ─────────────────────────────
		// Separate from the photo bucket so BucketDeployment prune cannot
		// delete portfolio objects.
		const websiteBucket = new Bucket(this, "WebsiteBucket", {
			websiteIndexDocument: "index.html",
			websiteErrorDocument: "404.html",
			publicReadAccess: true,
			blockPublicAccess: BlockPublicAccess.BLOCK_ACLS_ONLY,
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
		});

		// ── Portfolio photos (synced from the drive; not deployed by CDK) ──
		// Owned by this stack so CloudFront OAC can attach a bucket policy
		// cleanly without importing an external bucket.
		const photoBucket = new Bucket(this, "PhotoBucket", {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			encryption: BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
			// Keep objects if the stack is destroyed — portfolio originals.
			removalPolicy: RemovalPolicy.RETAIN,
			autoDeleteObjects: false,
			// Optional browser GETs from the site origin during local/dev checks.
			cors: [
				{
					allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
					allowedOrigins: [
						`https://${domainName}`,
						`https://${wwwDomain}`,
						"http://localhost:4321",
					],
					allowedHeaders: ["*"],
					maxAge: 86400,
				},
			],
		});

		const hostedZone = HostedZone.fromLookup(this, "HostedZone", {
			domainName,
		});

		const certificate = new Certificate(this, "Certificate", {
			domainName,
			subjectAlternativeNames: [wwwDomain, photosDomain],
			validation: CertificateValidation.fromDns(hostedZone),
		});

		// Long-lived cache for portfolio files. sync-photos-s3.sh always
		// invalidates the entire photo CDN (/*) after each sync.
		const photoCachePolicy = new CachePolicy(this, "PhotoCachePolicy", {
			cachePolicyName: `${this.stackName}-photos`,
			comment: "Long cache for portfolio originals",
			defaultTtl: Duration.days(365),
			maxTtl: Duration.days(365),
			minTtl: Duration.days(1),
			cookieBehavior: CacheCookieBehavior.none(),
			headerBehavior: CacheHeaderBehavior.none(),
			queryStringBehavior: CacheQueryStringBehavior.none(),
			enableAcceptEncodingGzip: true,
			enableAcceptEncodingBrotli: true,
		});

		// ── Site distribution: thelucidlens.com + www ───────────────────────
		const websiteDistribution = new Distribution(
			this,
			"WebsiteDistribution",
			{
				comment: `${domainName} website`,
				certificate,
				domainNames: [domainName, wwwDomain],
				defaultBehavior: {
					origin: new S3StaticWebsiteOrigin(websiteBucket),
					viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
					cachePolicy: CachePolicy.CACHING_OPTIMIZED,
					allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
					cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
				},
			},
		);

		// ── Photo distribution: photos.thelucidlens.com → photo bucket (OAC)
		const photoDistribution = new Distribution(this, "PhotoDistribution", {
			comment: `${photosDomain} portfolio photos`,
			certificate,
			domainNames: [photosDomain],
			defaultBehavior: {
				origin: S3BucketOrigin.withOriginAccessControl(photoBucket),
				viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
				cachePolicy: photoCachePolicy,
				allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
				cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
				compress: true,
			},
		});

		// Deploy Astro static build; invalidate site distribution on each deploy.
		// Path is relative to the stack package root (run `cdk` from stack/).
		//
		// waitForDistributionInvalidation: false avoids a known flaky failure where
		// the deploy Lambda cannot confirm invalidation completed (CDK #15891):
		// "Unable to confirm that cache invalidation was successful".
		// Invalidation is still created; we just do not block the stack on its status.
		new BucketDeployment(this, "WebsiteDeployment", {
			sources: [Source.asset("../website/dist")],
			destinationBucket: websiteBucket,
			distribution: websiteDistribution,
			distributionPaths: ["/*"],
			waitForDistributionInvalidation: false,
			// Larger Lambda helps big static assets; default 128MB can OOM on fat builds.
			memoryLimit: 512,
		});

		// DNS
		new ARecord(this, "ApexARecord", {
			zone: hostedZone,
			recordName: domainName,
			target: RecordTarget.fromAlias(
				new CloudFrontTarget(websiteDistribution),
			),
		});

		new ARecord(this, "WwwARecord", {
			zone: hostedZone,
			recordName: wwwDomain,
			target: RecordTarget.fromAlias(
				new CloudFrontTarget(websiteDistribution),
			),
		});

		new ARecord(this, "PhotosARecord", {
			zone: hostedZone,
			recordName: photosDomain,
			target: RecordTarget.fromAlias(new CloudFrontTarget(photoDistribution)),
		});

		new CfnOutput(this, "WebsiteUrl", {
			description: "Primary site URL",
			value: `https://${domainName}`,
		});

		new CfnOutput(this, "PhotosUrl", {
			description:
				"Photo CDN base URL (use as PHOTO_BASE_URL / import --base-url)",
			value: `https://${photosDomain}`,
		});

		new CfnOutput(this, "WebsiteDistributionDomainName", {
			description: "CloudFront domain for the website",
			value: websiteDistribution.domainName,
		});

		new CfnOutput(this, "PhotoDistributionDomainName", {
			description: "CloudFront domain for portfolio photos",
			value: photoDistribution.domainName,
		});

		new CfnOutput(this, "PhotoDistributionId", {
			description:
				"CloudFront distribution id for portfolio photos — used by sync-photos-s3.sh invalidation",
			value: photoDistribution.distributionId,
		});

		new CfnOutput(this, "WebsiteBucketName", {
			description: "S3 bucket for the Astro static site",
			value: websiteBucket.bucketName,
		});

		new CfnOutput(this, "PhotoBucketName", {
			description:
				"S3 bucket for portfolio photos — pass to sync-photos-s3.sh --bucket",
			value: photoBucket.bucketName,
		});
	}
}
