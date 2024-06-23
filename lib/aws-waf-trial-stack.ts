import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';


interface AwsWafTrialStackProps extends cdk.StackProps {
  allowedIP : string|undefined;
  allowedPrefixID : string|undefined;
}

export class AwsWafTrialStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: AwsWafTrialStackProps) {
    super(scope, id, props);

    const vpc = new cdk.aws_ec2.Vpc(this, 'wafTrialVPC', {
      natGateways: 0,
      ipAddresses: cdk.aws_ec2.IpAddresses.cidr('10.0.0.0/16'),
      vpcName: 'wafTrialVPC',
      maxAzs:2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'waf-trial-public',
          subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
          mapPublicIpOnLaunch: true
        }
      ]
    });

    // create elastic ip
    const bastionServerEIP = new cdk.aws_ec2.CfnEIP(this, 'wafTrialBastionServerEIP', {
      domain: 'vpc',
    });
    // create prefix list and save bastionServerEIP
    const bastionServerPrefixList = new cdk.aws_ec2.CfnPrefixList(this, 'wafTrialPrefixList', {
      addressFamily: 'IPv4',
      // max entries value can be from 0 to 65535
      maxEntries: 1,
      entries: [
        {
          cidr: bastionServerEIP.ref + '/32'
        }
      ],
      prefixListName: 'waf-trial-prefix-list'
    })

    // create key for bastion ec2
    const bastionEC2keypair = new cdk.aws_ec2.CfnKeyPair(this, 'wafTrialKeyPair', {
      keyName: 'waf-trial-key-pair',
    });

    // create security group for EC2
    const ec2SecurityGroup = new cdk.aws_ec2.SecurityGroup(this, 'wafTrialEC2SecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'security group for waf trial ec2',
      securityGroupName: 'waf-trial-ec2-sg',
    });

    if(props?.allowedIP !== undefined){
      ec2SecurityGroup.addIngressRule(
        cdk.aws_ec2.Peer.ipv4(props?.allowedIP),
        cdk.aws_ec2.Port.tcp(443),
        'allow ssh access from allowed ip'
      );
    }

    if(props?.allowedPrefixID !== undefined){
      ec2SecurityGroup.addIngressRule(
        cdk.aws_ec2.Peer.prefixList(props?.allowedPrefixID),
        cdk.aws_ec2.Port.tcp(443),
        'allow ssh access from allowed prefix id'
      );
    }

    // instance profile for allow session manager 
    const ec2Role = new cdk.aws_iam.Role(this, 'wafTrialEC2Role', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // create bastion ec2 server with eip
    // which have sshd config that listen port 443
    const bastionServer = new cdk.aws_ec2.Instance(this, 'wafTrialBastionServer', {
      vpc,
      instanceType: cdk.aws_ec2.InstanceType.of(cdk.aws_ec2.InstanceClass.T3, cdk.aws_ec2.InstanceSize.NANO),
      machineImage: cdk.aws_ec2.MachineImage.latestAmazonLinux2023(),
      keyName: bastionEC2keypair.keyName,
      securityGroup: ec2SecurityGroup,
      role: ec2Role,
      vpcSubnets: {
        subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
      },
    });

    bastionServer.addUserData(
      'yum update -y',
      'yum install -y openssh-server',
      'systemctl enable sshd',
      'sed -i "s/#Port 22/Port 443/" /etc/ssh/sshd_config',
      'systemctl restart sshd'
    )

    // associate eip
    new cdk.aws_ec2.CfnEIPAssociation(this, 'wafTrialBastionServerEIPAssociation', {
      eip: bastionServerEIP.ref,
      instanceId: bastionServer.instanceId,
    });

    // create webgoat ecs container
    const cluster = new cdk.aws_ecs.Cluster(this, 'wafTrialCluster', {
      clusterName: 'waf-trial-cluster',
      vpc,
    });

    // タスク定義の作成
    const taskDefinition = new cdk.aws_ecs.FargateTaskDefinition(this, 'WebgoatTaskDefinition', {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    const container = taskDefinition.addContainer('WebgoatContainer', {
      image: cdk.aws_ecs.ContainerImage.fromRegistry("webgoat/webgoat:v2023.8"),
      portMappings: [
        { containerPort: 8080, protocol: cdk.aws_ecs.Protocol.TCP },
        { containerPort: 9090, protocol: cdk.aws_ecs.Protocol.TCP },
      ],
      environment: {
        "WEBGOAT_HOST": "www.webgoat.local",
        "WEBWOLF_HOST": "www.webwolf.local"
      }
    });

    // waf acl
    const cfnWebACL = new cdk.aws_wafv2.CfnWebACL(this,"cfnWebACL",{
      defaultAction: {
        allow: {}
      },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: false,
        sampledRequestsEnabled: false,
        metricName: "WebGoatMetrics"
      },
      name: "WebGoatWebAclName",
      rules: [
        {
          name: "AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
              excludedRules:[
                {name: 'SizeRestrictions_QUERYSTRING'},
                {name: 'SizeRestrictions_Cookie_HEADER'},
                {name: 'SizeRestrictions_BODY'}, // 巨大なpayloadにするとWAFの検査対象範囲からすり抜けられるようにわざと設定
                {name: 'SizeRestrictions_URIPATH'},
              ]
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: "AWSManagedRulesCommonRuleSet",
          },
          overrideAction: {
            none: {}
          },
        }, 
        {
          name: "AWSManagedRulesSQLiRuleSet",
          priority: 2,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesSQLiRuleSet"
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: "AWSManagedRulesSQLiRuleSet",
          },
          overrideAction: {
            none: {}
          },
        },        
      ]
    });


    // ロードバランサーの作成
    const wafCoverdLB = new elbv2.ApplicationLoadBalancer(this, 'WebgoatLB', {
      vpc,
      internetFacing: true,
    });

    const rawLB = new elbv2.ApplicationLoadBalancer(this, 'WebgoatRAWLB', {
      vpc,
      internetFacing: true,
    });

    // associate with waf
    const webAclAssociation = new cdk.aws_wafv2.CfnWebACLAssociation(this,"webAclAssociation",
      {
        resourceArn: wafCoverdLB.loadBalancerArn,
        webAclArn: cfnWebACL.attrArn,
      }
    )
    webAclAssociation.addDependency(cfnWebACL)

    const listener = wafCoverdLB.addListener('WebgoatLBListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false
    });

    const listenerWolf = wafCoverdLB.addListener('WebwolfLBListener', {
      port: 9090,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false
    });

    const listenerRaw = rawLB.addListener('RawLBListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: false
    });

    // 8080ポート用のターゲットグループ
    const targetGroup1 = new elbv2.ApplicationTargetGroup(this, 'TargetGroup1', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/WebGoat',
        healthyHttpCodes: '200-499',
      },
    });
    const targetGroup3 = new elbv2.ApplicationTargetGroup(this, 'TargetGroup3', {
      vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/WebGoat',
        healthyHttpCodes: '200-499',
      },
    });

    // デフォルトアクションを設定
    listener.addAction('DefaultAction', {
      action: elbv2.ListenerAction.forward([targetGroup1]),
    });

    listenerRaw.addAction('DefaultActionLaw', {
      action: elbv2.ListenerAction.forward([targetGroup3]),
    });

    // 9090ポート用のターゲットグループ
    const targetGroup2 = new elbv2.ApplicationTargetGroup(this, 'TargetGroup2', {
      vpc,
      port: 9090,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/WebWolf',
        healthyHttpCodes: '200-499',
      },
    });

    // デフォルトアクションを設定
    listenerWolf.addAction('DefaultActionWolf', {
      action: elbv2.ListenerAction.forward([targetGroup2]),
    });


    const fargateServiceSG = new ec2.SecurityGroup(this, 'FargateServiceSG', {
      vpc,
      allowAllOutbound: true,
    });
    fargateServiceSG.connections.allowFrom(wafCoverdLB, ec2.Port.tcp(8080));
    fargateServiceSG.connections.allowFrom(wafCoverdLB, ec2.Port.tcp(9090));
    fargateServiceSG.connections.allowFrom(rawLB, ec2.Port.tcp(8080));
    fargateServiceSG.connections.allowFrom(ec2SecurityGroup, ec2.Port.allTraffic())

    // Fargateサービスの作成
    const fargateService = new ecs.FargateService(this, 'WebgoatService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: {
        subnetType: cdk.aws_ec2.SubnetType.PUBLIC,
      }, 
      securityGroups:[fargateServiceSG]
    })

    // サービスをターゲットグループに登録
    fargateService.attachToApplicationTargetGroup(targetGroup1);
    fargateService.attachToApplicationTargetGroup(targetGroup2);
    fargateService.attachToApplicationTargetGroup(targetGroup3);

    // プレフィックスリストからのアクセスを許可
    wafCoverdLB.connections.allowFrom(
      ec2.Peer.prefixList(bastionServerPrefixList.attrPrefixListId),
      ec2.Port.tcp(80),
      'allow https access from bastion server prefix list'
    );
    wafCoverdLB.connections.allowFrom(
      ec2.Peer.prefixList(bastionServerPrefixList.attrPrefixListId),
      ec2.Port.tcp(9090),
      'allow https access from bastion server prefix list'
    );
    rawLB.connections.allowFrom(
      ec2.Peer.prefixList(bastionServerPrefixList.attrPrefixListId),
      ec2.Port.tcp(80),
      'allow https access from bastion server prefix list'
    );

    // print lb domain name
    new cdk.CfnOutput(this, 'LoadBalancerWafDomainName', {
      value: wafCoverdLB.loadBalancerDnsName,
    });
    new cdk.CfnOutput(this, 'LoadBalancerRawDomainName', {
      value: rawLB.loadBalancerDnsName,
    });
    // print eip
    new cdk.CfnOutput(this, 'BastionServerEIP', {
      value: bastionServerEIP.ref,
    });
}
}
