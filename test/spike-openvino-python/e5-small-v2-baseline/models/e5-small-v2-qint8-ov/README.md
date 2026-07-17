---
tags:
- mteb
- Sentence Transformers
- sentence-similarity
- sentence-transformers
model-index:
- name: e5-small-v2
  results:
  - task:
      type: Classification
    dataset:
      type: mteb/amazon_counterfactual
      name: MTEB AmazonCounterfactualClassification (en)
      config: en
      split: test
      revision: e8379541af4e31359cca9fbcf4b00f2671dba205
    metrics:
    - type: accuracy
      value: 77.59701492537313
    - type: ap
      value: 41.67064885731708
    - type: f1
      value: 71.86465946398573
  - task:
      type: Classification
    dataset:
      type: mteb/amazon_polarity
      name: MTEB AmazonPolarityClassification
      config: default
      split: test
      revision: e2d317d38cd51312af73b3d32a06d1a08b442046
    metrics:
    - type: accuracy
      value: 91.265875
    - type: ap
      value: 87.67633085349644
    - type: f1
      value: 91.24297521425744
  - task:
      type: Classification
    dataset:
      type: mteb/amazon_reviews_multi
      name: MTEB AmazonReviewsClassification (en)
      config: en
      split: test
      revision: 1399c76144fd37290681b995c656ef9b2e06e26d
    metrics:
    - type: accuracy
      value: 45.882000000000005
    - type: f1
      value: 45.08058870381236
  - task:
      type: Retrieval
    dataset:
      type: arguana
      name: MTEB ArguAna
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 20.697
    - type: map_at_10
      value: 33.975
    - type: map_at_100
      value: 35.223
    - type: map_at_1000
      value: 35.260000000000005
    - type: map_at_3
      value: 29.776999999999997
    - type: map_at_5
      value: 32.035000000000004
    - type: mrr_at_1
      value: 20.982
    - type: mrr_at_10
      value: 34.094
    - type: mrr_at_100
      value: 35.343
    - type: mrr_at_1000
      value: 35.38
    - type: mrr_at_3
      value: 29.884
    - type: mrr_at_5
      value: 32.141999999999996
    - type: ndcg_at_1
      value: 20.697
    - type: ndcg_at_10
      value: 41.668
    - type: ndcg_at_100
      value: 47.397
    - type: ndcg_at_1000
      value: 48.305
    - type: ndcg_at_3
      value: 32.928000000000004
    - type: ndcg_at_5
      value: 36.998999999999995
    - type: precision_at_1
      value: 20.697
    - type: precision_at_10
      value: 6.636
    - type: precision_at_100
      value: 0.924
    - type: precision_at_1000
      value: 0.099
    - type: precision_at_3
      value: 14.035
    - type: precision_at_5
      value: 10.398
    - type: recall_at_1
      value: 20.697
    - type: recall_at_10
      value: 66.35799999999999
    - type: recall_at_100
      value: 92.39
    - type: recall_at_1000
      value: 99.36
    - type: recall_at_3
      value: 42.105
    - type: recall_at_5
      value: 51.991
  - task:
      type: Clustering
    dataset:
      type: mteb/arxiv-clustering-p2p
      name: MTEB ArxivClusteringP2P
      config: default
      split: test
      revision: a122ad7f3f0291bf49cc6f4d32aa80929df69d5d
    metrics:
    - type: v_measure
      value: 42.1169517447068
  - task:
      type: Clustering
    dataset:
      type: mteb/arxiv-clustering-s2s
      name: MTEB ArxivClusteringS2S
      config: default
      split: test
      revision: f910caf1a6075f7329cdf8c1a6135696f37dbd53
    metrics:
    - type: v_measure
      value: 34.79553720107097
  - task:
      type: Reranking
    dataset:
      type: mteb/askubuntudupquestions-reranking
      name: MTEB AskUbuntuDupQuestions
      config: default
      split: test
      revision: 2000358ca161889fa9c082cb41daa8dcfb161a54
    metrics:
    - type: map
      value: 58.10811337308168
    - type: mrr
      value: 71.56410763751482
  - task:
      type: STS
    dataset:
      type: mteb/biosses-sts
      name: MTEB BIOSSES
      config: default
      split: test
      revision: d3fb88f8f02e40887cd149695127462bbcf29b4a
    metrics:
    - type: cos_sim_pearson
      value: 78.46834918248696
    - type: cos_sim_spearman
      value: 79.4289182755206
    - type: euclidean_pearson
      value: 76.26662973727008
    - type: euclidean_spearman
      value: 78.11744260952536
    - type: manhattan_pearson
      value: 76.08175262609434
    - type: manhattan_spearman
      value: 78.29395265552289
  - task:
      type: Classification
    dataset:
      type: mteb/banking77
      name: MTEB Banking77Classification
      config: default
      split: test
      revision: 0fd18e25b25c072e09e0d92ab615fda904d66300
    metrics:
    - type: accuracy
      value: 81.63636363636364
    - type: f1
      value: 81.55779952376953
  - task:
      type: Clustering
    dataset:
      type: mteb/biorxiv-clustering-p2p
      name: MTEB BiorxivClusteringP2P
      config: default
      split: test
      revision: 65b79d1d13f80053f67aca9498d9402c2d9f1f40
    metrics:
    - type: v_measure
      value: 35.88541137137571
  - task:
      type: Clustering
    dataset:
      type: mteb/biorxiv-clustering-s2s
      name: MTEB BiorxivClusteringS2S
      config: default
      split: test
      revision: 258694dd0231531bc1fd9de6ceb52a0853c6d908
    metrics:
    - type: v_measure
      value: 30.05205685274407
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackAndroidRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 30.293999999999997
    - type: map_at_10
      value: 39.876
    - type: map_at_100
      value: 41.315000000000005
    - type: map_at_1000
      value: 41.451
    - type: map_at_3
      value: 37.194
    - type: map_at_5
      value: 38.728
    - type: mrr_at_1
      value: 37.053000000000004
    - type: mrr_at_10
      value: 45.281
    - type: mrr_at_100
      value: 46.188
    - type: mrr_at_1000
      value: 46.245999999999995
    - type: mrr_at_3
      value: 43.228
    - type: mrr_at_5
      value: 44.366
    - type: ndcg_at_1
      value: 37.053000000000004
    - type: ndcg_at_10
      value: 45.086
    - type: ndcg_at_100
      value: 50.756
    - type: ndcg_at_1000
      value: 53.123
    - type: ndcg_at_3
      value: 41.416
    - type: ndcg_at_5
      value: 43.098
    - type: precision_at_1
      value: 37.053000000000004
    - type: precision_at_10
      value: 8.34
    - type: precision_at_100
      value: 1.346
    - type: precision_at_1000
      value: 0.186
    - type: precision_at_3
      value: 19.647000000000002
    - type: precision_at_5
      value: 13.877
    - type: recall_at_1
      value: 30.293999999999997
    - type: recall_at_10
      value: 54.309
    - type: recall_at_100
      value: 78.59
    - type: recall_at_1000
      value: 93.82300000000001
    - type: recall_at_3
      value: 43.168
    - type: recall_at_5
      value: 48.192
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackEnglishRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 28.738000000000003
    - type: map_at_10
      value: 36.925999999999995
    - type: map_at_100
      value: 38.017
    - type: map_at_1000
      value: 38.144
    - type: map_at_3
      value: 34.446
    - type: map_at_5
      value: 35.704
    - type: mrr_at_1
      value: 35.478
    - type: mrr_at_10
      value: 42.786
    - type: mrr_at_100
      value: 43.458999999999996
    - type: mrr_at_1000
      value: 43.507
    - type: mrr_at_3
      value: 40.648
    - type: mrr_at_5
      value: 41.804
    - type: ndcg_at_1
      value: 35.478
    - type: ndcg_at_10
      value: 42.044
    - type: ndcg_at_100
      value: 46.249
    - type: ndcg_at_1000
      value: 48.44
    - type: ndcg_at_3
      value: 38.314
    - type: ndcg_at_5
      value: 39.798
    - type: precision_at_1
      value: 35.478
    - type: precision_at_10
      value: 7.764
    - type: precision_at_100
      value: 1.253
    - type: precision_at_1000
      value: 0.174
    - type: precision_at_3
      value: 18.047
    - type: precision_at_5
      value: 12.637
    - type: recall_at_1
      value: 28.738000000000003
    - type: recall_at_10
      value: 50.659
    - type: recall_at_100
      value: 68.76299999999999
    - type: recall_at_1000
      value: 82.811
    - type: recall_at_3
      value: 39.536
    - type: recall_at_5
      value: 43.763999999999996
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackGamingRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 38.565
    - type: map_at_10
      value: 50.168
    - type: map_at_100
      value: 51.11
    - type: map_at_1000
      value: 51.173
    - type: map_at_3
      value: 47.044000000000004
    - type: map_at_5
      value: 48.838
    - type: mrr_at_1
      value: 44.201
    - type: mrr_at_10
      value: 53.596999999999994
    - type: mrr_at_100
      value: 54.211
    - type: mrr_at_1000
      value: 54.247
    - type: mrr_at_3
      value: 51.202000000000005
    - type: mrr_at_5
      value: 52.608999999999995
    - type: ndcg_at_1
      value: 44.201
    - type: ndcg_at_10
      value: 55.694
    - type: ndcg_at_100
      value: 59.518
    - type: ndcg_at_1000
      value: 60.907
    - type: ndcg_at_3
      value: 50.395999999999994
    - type: ndcg_at_5
      value: 53.022999999999996
    - type: precision_at_1
      value: 44.201
    - type: precision_at_10
      value: 8.84
    - type: precision_at_100
      value: 1.162
    - type: precision_at_1000
      value: 0.133
    - type: precision_at_3
      value: 22.153
    - type: precision_at_5
      value: 15.260000000000002
    - type: recall_at_1
      value: 38.565
    - type: recall_at_10
      value: 68.65
    - type: recall_at_100
      value: 85.37400000000001
    - type: recall_at_1000
      value: 95.37400000000001
    - type: recall_at_3
      value: 54.645999999999994
    - type: recall_at_5
      value: 60.958
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackGisRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 23.945
    - type: map_at_10
      value: 30.641000000000002
    - type: map_at_100
      value: 31.599
    - type: map_at_1000
      value: 31.691000000000003
    - type: map_at_3
      value: 28.405
    - type: map_at_5
      value: 29.704000000000004
    - type: mrr_at_1
      value: 25.537
    - type: mrr_at_10
      value: 32.22
    - type: mrr_at_100
      value: 33.138
    - type: mrr_at_1000
      value: 33.214
    - type: mrr_at_3
      value: 30.151
    - type: mrr_at_5
      value: 31.298
    - type: ndcg_at_1
      value: 25.537
    - type: ndcg_at_10
      value: 34.638000000000005
    - type: ndcg_at_100
      value: 39.486
    - type: ndcg_at_1000
      value: 41.936
    - type: ndcg_at_3
      value: 30.333
    - type: ndcg_at_5
      value: 32.482
    - type: precision_at_1
      value: 25.537
    - type: precision_at_10
      value: 5.153
    - type: precision_at_100
      value: 0.7929999999999999
    - type: precision_at_1000
      value: 0.104
    - type: precision_at_3
      value: 12.429
    - type: precision_at_5
      value: 8.723
    - type: recall_at_1
      value: 23.945
    - type: recall_at_10
      value: 45.412
    - type: recall_at_100
      value: 67.836
    - type: recall_at_1000
      value: 86.467
    - type: recall_at_3
      value: 34.031
    - type: recall_at_5
      value: 39.039
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackMathematicaRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 14.419
    - type: map_at_10
      value: 20.858999999999998
    - type: map_at_100
      value: 22.067999999999998
    - type: map_at_1000
      value: 22.192
    - type: map_at_3
      value: 18.673000000000002
    - type: map_at_5
      value: 19.968
    - type: mrr_at_1
      value: 17.785999999999998
    - type: mrr_at_10
      value: 24.878
    - type: mrr_at_100
      value: 26.021
    - type: mrr_at_1000
      value: 26.095000000000002
    - type: mrr_at_3
      value: 22.616
    - type: mrr_at_5
      value: 23.785
    - type: ndcg_at_1
      value: 17.785999999999998
    - type: ndcg_at_10
      value: 25.153
    - type: ndcg_at_100
      value: 31.05
    - type: ndcg_at_1000
      value: 34.052
    - type: ndcg_at_3
      value: 21.117
    - type: ndcg_at_5
      value: 23.048
    - type: precision_at_1
      value: 17.785999999999998
    - type: precision_at_10
      value: 4.590000000000001
    - type: precision_at_100
      value: 0.864
    - type: precision_at_1000
      value: 0.125
    - type: precision_at_3
      value: 9.908999999999999
    - type: precision_at_5
      value: 7.313
    - type: recall_at_1
      value: 14.419
    - type: recall_at_10
      value: 34.477999999999994
    - type: recall_at_100
      value: 60.02499999999999
    - type: recall_at_1000
      value: 81.646
    - type: recall_at_3
      value: 23.515
    - type: recall_at_5
      value: 28.266999999999996
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackPhysicsRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 26.268
    - type: map_at_10
      value: 35.114000000000004
    - type: map_at_100
      value: 36.212
    - type: map_at_1000
      value: 36.333
    - type: map_at_3
      value: 32.436
    - type: map_at_5
      value: 33.992
    - type: mrr_at_1
      value: 31.761
    - type: mrr_at_10
      value: 40.355999999999995
    - type: mrr_at_100
      value: 41.125
    - type: mrr_at_1000
      value: 41.186
    - type: mrr_at_3
      value: 37.937
    - type: mrr_at_5
      value: 39.463
    - type: ndcg_at_1
      value: 31.761
    - type: ndcg_at_10
      value: 40.422000000000004
    - type: ndcg_at_100
      value: 45.458999999999996
    - type: ndcg_at_1000
      value: 47.951
    - type: ndcg_at_3
      value: 35.972
    - type: ndcg_at_5
      value: 38.272
    - type: precision_at_1
      value: 31.761
    - type: precision_at_10
      value: 7.103
    - type: precision_at_100
      value: 1.133
    - type: precision_at_1000
      value: 0.152
    - type: precision_at_3
      value: 16.779
    - type: precision_at_5
      value: 11.877
    - type: recall_at_1
      value: 26.268
    - type: recall_at_10
      value: 51.053000000000004
    - type: recall_at_100
      value: 72.702
    - type: recall_at_1000
      value: 89.521
    - type: recall_at_3
      value: 38.619
    - type: recall_at_5
      value: 44.671
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackProgrammersRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 25.230999999999998
    - type: map_at_10
      value: 34.227000000000004
    - type: map_at_100
      value: 35.370000000000005
    - type: map_at_1000
      value: 35.488
    - type: map_at_3
      value: 31.496000000000002
    - type: map_at_5
      value: 33.034
    - type: mrr_at_1
      value: 30.822
    - type: mrr_at_10
      value: 39.045
    - type: mrr_at_100
      value: 39.809
    - type: mrr_at_1000
      value: 39.873
    - type: mrr_at_3
      value: 36.663000000000004
    - type: mrr_at_5
      value: 37.964
    - type: ndcg_at_1
      value: 30.822
    - type: ndcg_at_10
      value: 39.472
    - type: ndcg_at_100
      value: 44.574999999999996
    - type: ndcg_at_1000
      value: 47.162
    - type: ndcg_at_3
      value: 34.929
    - type: ndcg_at_5
      value: 37.002
    - type: precision_at_1
      value: 30.822
    - type: precision_at_10
      value: 7.055
    - type: precision_at_100
      value: 1.124
    - type: precision_at_1000
      value: 0.152
    - type: precision_at_3
      value: 16.591
    - type: precision_at_5
      value: 11.667
    - type: recall_at_1
      value: 25.230999999999998
    - type: recall_at_10
      value: 50.42100000000001
    - type: recall_at_100
      value: 72.685
    - type: recall_at_1000
      value: 90.469
    - type: recall_at_3
      value: 37.503
    - type: recall_at_5
      value: 43.123
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 24.604166666666664
    - type: map_at_10
      value: 32.427166666666665
    - type: map_at_100
      value: 33.51474999999999
    - type: map_at_1000
      value: 33.6345
    - type: map_at_3
      value: 30.02366666666667
    - type: map_at_5
      value: 31.382333333333328
    - type: mrr_at_1
      value: 29.001166666666666
    - type: mrr_at_10
      value: 36.3315
    - type: mrr_at_100
      value: 37.16683333333333
    - type: mrr_at_1000
      value: 37.23341666666668
    - type: mrr_at_3
      value: 34.19916666666667
    - type: mrr_at_5
      value: 35.40458333333334
    - type: ndcg_at_1
      value: 29.001166666666666
    - type: ndcg_at_10
      value: 37.06883333333334
    - type: ndcg_at_100
      value: 41.95816666666666
    - type: ndcg_at_1000
      value: 44.501583333333336
    - type: ndcg_at_3
      value: 32.973499999999994
    - type: ndcg_at_5
      value: 34.90833333333334
    - type: precision_at_1
      value: 29.001166666666666
    - type: precision_at_10
      value: 6.336
    - type: precision_at_100
      value: 1.0282499999999999
    - type: precision_at_1000
      value: 0.14391666666666664
    - type: precision_at_3
      value: 14.932499999999996
    - type: precision_at_5
      value: 10.50825
    - type: recall_at_1
      value: 24.604166666666664
    - type: recall_at_10
      value: 46.9525
    - type: recall_at_100
      value: 68.67816666666667
    - type: recall_at_1000
      value: 86.59783333333334
    - type: recall_at_3
      value: 35.49783333333333
    - type: recall_at_5
      value: 40.52525000000001
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackStatsRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 23.559
    - type: map_at_10
      value: 29.023
    - type: map_at_100
      value: 29.818
    - type: map_at_1000
      value: 29.909000000000002
    - type: map_at_3
      value: 27.037
    - type: map_at_5
      value: 28.225
    - type: mrr_at_1
      value: 26.994
    - type: mrr_at_10
      value: 31.962000000000003
    - type: mrr_at_100
      value: 32.726
    - type: mrr_at_1000
      value: 32.800000000000004
    - type: mrr_at_3
      value: 30.266
    - type: mrr_at_5
      value: 31.208999999999996
    - type: ndcg_at_1
      value: 26.994
    - type: ndcg_at_10
      value: 32.53
    - type: ndcg_at_100
      value: 36.758
    - type: ndcg_at_1000
      value: 39.362
    - type: ndcg_at_3
      value: 28.985
    - type: ndcg_at_5
      value: 30.757
    - type: precision_at_1
      value: 26.994
    - type: precision_at_10
      value: 4.968999999999999
    - type: precision_at_100
      value: 0.759
    - type: precision_at_1000
      value: 0.106
    - type: precision_at_3
      value: 12.219
    - type: precision_at_5
      value: 8.527999999999999
    - type: recall_at_1
      value: 23.559
    - type: recall_at_10
      value: 40.585
    - type: recall_at_100
      value: 60.306000000000004
    - type: recall_at_1000
      value: 80.11
    - type: recall_at_3
      value: 30.794
    - type: recall_at_5
      value: 35.186
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackTexRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 16.384999999999998
    - type: map_at_10
      value: 22.142
    - type: map_at_100
      value: 23.057
    - type: map_at_1000
      value: 23.177
    - type: map_at_3
      value: 20.29
    - type: map_at_5
      value: 21.332
    - type: mrr_at_1
      value: 19.89
    - type: mrr_at_10
      value: 25.771
    - type: mrr_at_100
      value: 26.599
    - type: mrr_at_1000
      value: 26.680999999999997
    - type: mrr_at_3
      value: 23.962
    - type: mrr_at_5
      value: 24.934
    - type: ndcg_at_1
      value: 19.89
    - type: ndcg_at_10
      value: 25.97
    - type: ndcg_at_100
      value: 30.605
    - type: ndcg_at_1000
      value: 33.619
    - type: ndcg_at_3
      value: 22.704
    - type: ndcg_at_5
      value: 24.199
    - type: precision_at_1
      value: 19.89
    - type: precision_at_10
      value: 4.553
    - type: precision_at_100
      value: 0.8049999999999999
    - type: precision_at_1000
      value: 0.122
    - type: precision_at_3
      value: 10.541
    - type: precision_at_5
      value: 7.46
    - type: recall_at_1
      value: 16.384999999999998
    - type: recall_at_10
      value: 34.001
    - type: recall_at_100
      value: 55.17100000000001
    - type: recall_at_1000
      value: 77.125
    - type: recall_at_3
      value: 24.618000000000002
    - type: recall_at_5
      value: 28.695999999999998
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackUnixRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 23.726
    - type: map_at_10
      value: 31.227
    - type: map_at_100
      value: 32.311
    - type: map_at_1000
      value: 32.419
    - type: map_at_3
      value: 28.765
    - type: map_at_5
      value: 30.229
    - type: mrr_at_1
      value: 27.705000000000002
    - type: mrr_at_10
      value: 35.085
    - type: mrr_at_100
      value: 35.931000000000004
    - type: mrr_at_1000
      value: 36
    - type: mrr_at_3
      value: 32.603
    - type: mrr_at_5
      value: 34.117999999999995
    - type: ndcg_at_1
      value: 27.705000000000002
    - type: ndcg_at_10
      value: 35.968
    - type: ndcg_at_100
      value: 41.197
    - type: ndcg_at_1000
      value: 43.76
    - type: ndcg_at_3
      value: 31.304
    - type: ndcg_at_5
      value: 33.661
    - type: precision_at_1
      value: 27.705000000000002
    - type: precision_at_10
      value: 5.942
    - type: precision_at_100
      value: 0.964
    - type: precision_at_1000
      value: 0.13
    - type: precision_at_3
      value: 13.868
    - type: precision_at_5
      value: 9.944
    - type: recall_at_1
      value: 23.726
    - type: recall_at_10
      value: 46.786
    - type: recall_at_100
      value: 70.072
    - type: recall_at_1000
      value: 88.2
    - type: recall_at_3
      value: 33.981
    - type: recall_at_5
      value: 39.893
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackWebmastersRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 23.344
    - type: map_at_10
      value: 31.636999999999997
    - type: map_at_100
      value: 33.065
    - type: map_at_1000
      value: 33.300000000000004
    - type: map_at_3
      value: 29.351
    - type: map_at_5
      value: 30.432
    - type: mrr_at_1
      value: 27.866000000000003
    - type: mrr_at_10
      value: 35.587
    - type: mrr_at_100
      value: 36.52
    - type: mrr_at_1000
      value: 36.597
    - type: mrr_at_3
      value: 33.696
    - type: mrr_at_5
      value: 34.713
    - type: ndcg_at_1
      value: 27.866000000000003
    - type: ndcg_at_10
      value: 36.61
    - type: ndcg_at_100
      value: 41.88
    - type: ndcg_at_1000
      value: 45.105000000000004
    - type: ndcg_at_3
      value: 33.038000000000004
    - type: ndcg_at_5
      value: 34.331
    - type: precision_at_1
      value: 27.866000000000003
    - type: precision_at_10
      value: 6.917
    - type: precision_at_100
      value: 1.3599999999999999
    - type: precision_at_1000
      value: 0.233
    - type: precision_at_3
      value: 15.547
    - type: precision_at_5
      value: 10.791
    - type: recall_at_1
      value: 23.344
    - type: recall_at_10
      value: 45.782000000000004
    - type: recall_at_100
      value: 69.503
    - type: recall_at_1000
      value: 90.742
    - type: recall_at_3
      value: 35.160000000000004
    - type: recall_at_5
      value: 39.058
  - task:
      type: Retrieval
    dataset:
      type: BeIR/cqadupstack
      name: MTEB CQADupstackWordpressRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 20.776
    - type: map_at_10
      value: 27.285999999999998
    - type: map_at_100
      value: 28.235
    - type: map_at_1000
      value: 28.337
    - type: map_at_3
      value: 25.147000000000002
    - type: map_at_5
      value: 26.401999999999997
    - type: mrr_at_1
      value: 22.921
    - type: mrr_at_10
      value: 29.409999999999997
    - type: mrr_at_100
      value: 30.275000000000002
    - type: mrr_at_1000
      value: 30.354999999999997
    - type: mrr_at_3
      value: 27.418
    - type: mrr_at_5
      value: 28.592000000000002
    - type: ndcg_at_1
      value: 22.921
    - type: ndcg_at_10
      value: 31.239
    - type: ndcg_at_100
      value: 35.965
    - type: ndcg_at_1000
      value: 38.602
    - type: ndcg_at_3
      value: 27.174
    - type: ndcg_at_5
      value: 29.229
    - type: precision_at_1
      value: 22.921
    - type: precision_at_10
      value: 4.806
    - type: precision_at_100
      value: 0.776
    - type: precision_at_1000
      value: 0.11
    - type: precision_at_3
      value: 11.459999999999999
    - type: precision_at_5
      value: 8.022
    - type: recall_at_1
      value: 20.776
    - type: recall_at_10
      value: 41.294
    - type: recall_at_100
      value: 63.111
    - type: recall_at_1000
      value: 82.88600000000001
    - type: recall_at_3
      value: 30.403000000000002
    - type: recall_at_5
      value: 35.455999999999996
  - task:
      type: Retrieval
    dataset:
      type: climate-fever
      name: MTEB ClimateFEVER
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 9.376
    - type: map_at_10
      value: 15.926000000000002
    - type: map_at_100
      value: 17.585
    - type: map_at_1000
      value: 17.776
    - type: map_at_3
      value: 13.014000000000001
    - type: map_at_5
      value: 14.417
    - type: mrr_at_1
      value: 20.195
    - type: mrr_at_10
      value: 29.95
    - type: mrr_at_100
      value: 31.052000000000003
    - type: mrr_at_1000
      value: 31.108000000000004
    - type: mrr_at_3
      value: 26.667
    - type: mrr_at_5
      value: 28.458
    - type: ndcg_at_1
      value: 20.195
    - type: ndcg_at_10
      value: 22.871
    - type: ndcg_at_100
      value: 29.921999999999997
    - type: ndcg_at_1000
      value: 33.672999999999995
    - type: ndcg_at_3
      value: 17.782999999999998
    - type: ndcg_at_5
      value: 19.544
    - type: precision_at_1
      value: 20.195
    - type: precision_at_10
      value: 7.394
    - type: precision_at_100
      value: 1.493
    - type: precision_at_1000
      value: 0.218
    - type: precision_at_3
      value: 13.073
    - type: precision_at_5
      value: 10.436
    - type: recall_at_1
      value: 9.376
    - type: recall_at_10
      value: 28.544999999999998
    - type: recall_at_100
      value: 53.147999999999996
    - type: recall_at_1000
      value: 74.62
    - type: recall_at_3
      value: 16.464000000000002
    - type: recall_at_5
      value: 21.004
  - task:
      type: Retrieval
    dataset:
      type: dbpedia-entity
      name: MTEB DBPedia
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 8.415000000000001
    - type: map_at_10
      value: 18.738
    - type: map_at_100
      value: 27.291999999999998
    - type: map_at_1000
      value: 28.992
    - type: map_at_3
      value: 13.196
    - type: map_at_5
      value: 15.539
    - type: mrr_at_1
      value: 66.5
    - type: mrr_at_10
      value: 74.518
    - type: mrr_at_100
      value: 74.86
    - type: mrr_at_1000
      value: 74.87
    - type: mrr_at_3
      value: 72.375
    - type: mrr_at_5
      value: 73.86200000000001
    - type: ndcg_at_1
      value: 54.37499999999999
    - type: ndcg_at_10
      value: 41.317
    - type: ndcg_at_100
      value: 45.845
    - type: ndcg_at_1000
      value: 52.92
    - type: ndcg_at_3
      value: 44.983000000000004
    - type: ndcg_at_5
      value: 42.989
    - type: precision_at_1
      value: 66.5
    - type: precision_at_10
      value: 33.6
    - type: precision_at_100
      value: 10.972999999999999
    - type: precision_at_1000
      value: 2.214
    - type: precision_at_3
      value: 48.583
    - type: precision_at_5
      value: 42.15
    - type: recall_at_1
      value: 8.415000000000001
    - type: recall_at_10
      value: 24.953
    - type: recall_at_100
      value: 52.48199999999999
    - type: recall_at_1000
      value: 75.093
    - type: recall_at_3
      value: 14.341000000000001
    - type: recall_at_5
      value: 18.468
  - task:
      type: Classification
    dataset:
      type: mteb/emotion
      name: MTEB EmotionClassification
      config: default
      split: test
      revision: 4f58c6b202a23cf9a4da393831edf4f9183cad37
    metrics:
    - type: accuracy
      value: 47.06499999999999
    - type: f1
      value: 41.439327599975385
  - task:
      type: Retrieval
    dataset:
      type: fever
      name: MTEB FEVER
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 66.02
    - type: map_at_10
      value: 76.68599999999999
    - type: map_at_100
      value: 76.959
    - type: map_at_1000
      value: 76.972
    - type: map_at_3
      value: 75.024
    - type: map_at_5
      value: 76.153
    - type: mrr_at_1
      value: 71.197
    - type: mrr_at_10
      value: 81.105
    - type: mrr_at_100
      value: 81.232
    - type: mrr_at_1000
      value: 81.233
    - type: mrr_at_3
      value: 79.758
    - type: mrr_at_5
      value: 80.69
    - type: ndcg_at_1
      value: 71.197
    - type: ndcg_at_10
      value: 81.644
    - type: ndcg_at_100
      value: 82.645
    - type: ndcg_at_1000
      value: 82.879
    - type: ndcg_at_3
      value: 78.792
    - type: ndcg_at_5
      value: 80.528
    - type: precision_at_1
      value: 71.197
    - type: precision_at_10
      value: 10.206999999999999
    - type: precision_at_100
      value: 1.093
    - type: precision_at_1000
      value: 0.11299999999999999
    - type: precision_at_3
      value: 30.868000000000002
    - type: precision_at_5
      value: 19.559
    - type: recall_at_1
      value: 66.02
    - type: recall_at_10
      value: 92.50699999999999
    - type: recall_at_100
      value: 96.497
    - type: recall_at_1000
      value: 97.956
    - type: recall_at_3
      value: 84.866
    - type: recall_at_5
      value: 89.16199999999999
  - task:
      type: Retrieval
    dataset:
      type: fiqa
      name: MTEB FiQA2018
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 17.948
    - type: map_at_10
      value: 29.833
    - type: map_at_100
      value: 31.487
    - type: map_at_1000
      value: 31.674000000000003
    - type: map_at_3
      value: 26.029999999999998
    - type: map_at_5
      value: 28.038999999999998
    - type: mrr_at_1
      value: 34.721999999999994
    - type: mrr_at_10
      value: 44.214999999999996
    - type: mrr_at_100
      value: 44.994
    - type: mrr_at_1000
      value: 45.051
    - type: mrr_at_3
      value: 41.667
    - type: mrr_at_5
      value: 43.032
    - type: ndcg_at_1
      value: 34.721999999999994
    - type: ndcg_at_10
      value: 37.434
    - type: ndcg_at_100
      value: 43.702000000000005
    - type: ndcg_at_1000
      value: 46.993
    - type: ndcg_at_3
      value: 33.56
    - type: ndcg_at_5
      value: 34.687
    - type: precision_at_1
      value: 34.721999999999994
    - type: precision_at_10
      value: 10.401
    - type: precision_at_100
      value: 1.7049999999999998
    - type: precision_at_1000
      value: 0.22799999999999998
    - type: precision_at_3
      value: 22.531000000000002
    - type: precision_at_5
      value: 16.42
    - type: recall_at_1
      value: 17.948
    - type: recall_at_10
      value: 45.062999999999995
    - type: recall_at_100
      value: 68.191
    - type: recall_at_1000
      value: 87.954
    - type: recall_at_3
      value: 31.112000000000002
    - type: recall_at_5
      value: 36.823
  - task:
      type: Retrieval
    dataset:
      type: hotpotqa
      name: MTEB HotpotQA
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 36.644
    - type: map_at_10
      value: 57.658
    - type: map_at_100
      value: 58.562000000000005
    - type: map_at_1000
      value: 58.62500000000001
    - type: map_at_3
      value: 54.022999999999996
    - type: map_at_5
      value: 56.293000000000006
    - type: mrr_at_1
      value: 73.288
    - type: mrr_at_10
      value: 80.51700000000001
    - type: mrr_at_100
      value: 80.72
    - type: mrr_at_1000
      value: 80.728
    - type: mrr_at_3
      value: 79.33200000000001
    - type: mrr_at_5
      value: 80.085
    - type: ndcg_at_1
      value: 73.288
    - type: ndcg_at_10
      value: 66.61
    - type: ndcg_at_100
      value: 69.723
    - type: ndcg_at_1000
      value: 70.96000000000001
    - type: ndcg_at_3
      value: 61.358999999999995
    - type: ndcg_at_5
      value: 64.277
    - type: precision_at_1
      value: 73.288
    - type: precision_at_10
      value: 14.17
    - type: precision_at_100
      value: 1.659
    - type: precision_at_1000
      value: 0.182
    - type: precision_at_3
      value: 39.487
    - type: precision_at_5
      value: 25.999
    - type: recall_at_1
      value: 36.644
    - type: recall_at_10
      value: 70.851
    - type: recall_at_100
      value: 82.94399999999999
    - type: recall_at_1000
      value: 91.134
    - type: recall_at_3
      value: 59.230000000000004
    - type: recall_at_5
      value: 64.997
  - task:
      type: Classification
    dataset:
      type: mteb/imdb
      name: MTEB ImdbClassification
      config: default
      split: test
      revision: 3d86128a09e091d6018b6d26cad27f2739fc2db7
    metrics:
    - type: accuracy
      value: 86.00280000000001
    - type: ap
      value: 80.46302061021223
    - type: f1
      value: 85.9592921596419
  - task:
      type: Retrieval
    dataset:
      type: msmarco
      name: MTEB MSMARCO
      config: default
      split: dev
      revision: None
    metrics:
    - type: map_at_1
      value: 22.541
    - type: map_at_10
      value: 34.625
    - type: map_at_100
      value: 35.785
    - type: map_at_1000
      value: 35.831
    - type: map_at_3
      value: 30.823
    - type: map_at_5
      value: 32.967999999999996
    - type: mrr_at_1
      value: 23.180999999999997
    - type: mrr_at_10
      value: 35.207
    - type: mrr_at_100
      value: 36.315
    - type: mrr_at_1000
      value: 36.355
    - type: mrr_at_3
      value: 31.483
    - type: mrr_at_5
      value: 33.589999999999996
    - type: ndcg_at_1
      value: 23.195
    - type: ndcg_at_10
      value: 41.461
    - type: ndcg_at_100
      value: 47.032000000000004
    - type: ndcg_at_1000
      value: 48.199999999999996
    - type: ndcg_at_3
      value: 33.702
    - type: ndcg_at_5
      value: 37.522
    - type: precision_at_1
      value: 23.195
    - type: precision_at_10
      value: 6.526999999999999
    - type: precision_at_100
      value: 0.932
    - type: precision_at_1000
      value: 0.10300000000000001
    - type: precision_at_3
      value: 14.308000000000002
    - type: precision_at_5
      value: 10.507
    - type: recall_at_1
      value: 22.541
    - type: recall_at_10
      value: 62.524
    - type: recall_at_100
      value: 88.228
    - type: recall_at_1000
      value: 97.243
    - type: recall_at_3
      value: 41.38
    - type: recall_at_5
      value: 50.55
  - task:
      type: Classification
    dataset:
      type: mteb/mtop_domain
      name: MTEB MTOPDomainClassification (en)
      config: en
      split: test
      revision: d80d48c1eb48d3562165c59d59d0034df9fff0bf
    metrics:
    - type: accuracy
      value: 92.69949840401279
    - type: f1
      value: 92.54141471311786
  - task:
      type: Classification
    dataset:
      type: mteb/mtop_intent
      name: MTEB MTOPIntentClassification (en)
      config: en
      split: test
      revision: ae001d0e6b1228650b7bd1c2c65fb50ad11a8aba
    metrics:
    - type: accuracy
      value: 72.56041951664386
    - type: f1
      value: 55.88499977508287
  - task:
      type: Classification
    dataset:
      type: mteb/amazon_massive_intent
      name: MTEB MassiveIntentClassification (en)
      config: en
      split: test
      revision: 31efe3c427b0bae9c22cbb560b8f15491cc6bed7
    metrics:
    - type: accuracy
      value: 71.62071284465365
    - type: f1
      value: 69.36717546572152
  - task:
      type: Classification
    dataset:
      type: mteb/amazon_massive_scenario
      name: MTEB MassiveScenarioClassification (en)
      config: en
      split: test
      revision: 7d571f92784cd94a019292a1f45445077d0ef634
    metrics:
    - type: accuracy
      value: 76.35843981170142
    - type: f1
      value: 76.15496453538884
  - task:
      type: Clustering
    dataset:
      type: mteb/medrxiv-clustering-p2p
      name: MTEB MedrxivClusteringP2P
      config: default
      split: test
      revision: e7a26af6f3ae46b30dde8737f02c07b1505bcc73
    metrics:
    - type: v_measure
      value: 31.33664956793118
  - task:
      type: Clustering
    dataset:
      type: mteb/medrxiv-clustering-s2s
      name: MTEB MedrxivClusteringS2S
      config: default
      split: test
      revision: 35191c8c0dca72d8ff3efcd72aa802307d469663
    metrics:
    - type: v_measure
      value: 27.883839621715524
  - task:
      type: Reranking
    dataset:
      type: mteb/mind_small
      name: MTEB MindSmallReranking
      config: default
      split: test
      revision: 3bdac13927fdc888b903db93b2ffdbd90b295a69
    metrics:
    - type: map
      value: 30.096874986740758
    - type: mrr
      value: 30.97300481932132
  - task:
      type: Retrieval
    dataset:
      type: nfcorpus
      name: MTEB NFCorpus
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 5.4
    - type: map_at_10
      value: 11.852
    - type: map_at_100
      value: 14.758
    - type: map_at_1000
      value: 16.134
    - type: map_at_3
      value: 8.558
    - type: map_at_5
      value: 10.087
    - type: mrr_at_1
      value: 44.272
    - type: mrr_at_10
      value: 52.05800000000001
    - type: mrr_at_100
      value: 52.689
    - type: mrr_at_1000
      value: 52.742999999999995
    - type: mrr_at_3
      value: 50.205999999999996
    - type: mrr_at_5
      value: 51.367
    - type: ndcg_at_1
      value: 42.57
    - type: ndcg_at_10
      value: 32.449
    - type: ndcg_at_100
      value: 29.596
    - type: ndcg_at_1000
      value: 38.351
    - type: ndcg_at_3
      value: 37.044
    - type: ndcg_at_5
      value: 35.275
    - type: precision_at_1
      value: 44.272
    - type: precision_at_10
      value: 23.87
    - type: precision_at_100
      value: 7.625
    - type: precision_at_1000
      value: 2.045
    - type: precision_at_3
      value: 34.365
    - type: precision_at_5
      value: 30.341
    - type: recall_at_1
      value: 5.4
    - type: recall_at_10
      value: 15.943999999999999
    - type: recall_at_100
      value: 29.805
    - type: recall_at_1000
      value: 61.695
    - type: recall_at_3
      value: 9.539
    - type: recall_at_5
      value: 12.127
  - task:
      type: Retrieval
    dataset:
      type: nq
      name: MTEB NQ
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 36.047000000000004
    - type: map_at_10
      value: 51.6
    - type: map_at_100
      value: 52.449999999999996
    - type: map_at_1000
      value: 52.476
    - type: map_at_3
      value: 47.452
    - type: map_at_5
      value: 49.964
    - type: mrr_at_1
      value: 40.382
    - type: mrr_at_10
      value: 54.273
    - type: mrr_at_100
      value: 54.859
    - type: mrr_at_1000
      value: 54.876000000000005
    - type: mrr_at_3
      value: 51.014
    - type: mrr_at_5
      value: 52.983999999999995
    - type: ndcg_at_1
      value: 40.353
    - type: ndcg_at_10
      value: 59.11300000000001
    - type: ndcg_at_100
      value: 62.604000000000006
    - type: ndcg_at_1000
      value: 63.187000000000005
    - type: ndcg_at_3
      value: 51.513
    - type: ndcg_at_5
      value: 55.576
    - type: precision_at_1
      value: 40.353
    - type: precision_at_10
      value: 9.418
    - type: precision_at_100
      value: 1.1440000000000001
    - type: precision_at_1000
      value: 0.12
    - type: precision_at_3
      value: 23.078000000000003
    - type: precision_at_5
      value: 16.250999999999998
    - type: recall_at_1
      value: 36.047000000000004
    - type: recall_at_10
      value: 79.22200000000001
    - type: recall_at_100
      value: 94.23
    - type: recall_at_1000
      value: 98.51100000000001
    - type: recall_at_3
      value: 59.678
    - type: recall_at_5
      value: 68.967
  - task:
      type: Retrieval
    dataset:
      type: quora
      name: MTEB QuoraRetrieval
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 68.232
    - type: map_at_10
      value: 81.674
    - type: map_at_100
      value: 82.338
    - type: map_at_1000
      value: 82.36099999999999
    - type: map_at_3
      value: 78.833
    - type: map_at_5
      value: 80.58
    - type: mrr_at_1
      value: 78.64
    - type: mrr_at_10
      value: 85.164
    - type: mrr_at_100
      value: 85.317
    - type: mrr_at_1000
      value: 85.319
    - type: mrr_at_3
      value: 84.127
    - type: mrr_at_5
      value: 84.789
    - type: ndcg_at_1
      value: 78.63
    - type: ndcg_at_10
      value: 85.711
    - type: ndcg_at_100
      value: 87.238
    - type: ndcg_at_1000
      value: 87.444
    - type: ndcg_at_3
      value: 82.788
    - type: ndcg_at_5
      value: 84.313
    - type: precision_at_1
      value: 78.63
    - type: precision_at_10
      value: 12.977
    - type: precision_at_100
      value: 1.503
    - type: precision_at_1000
      value: 0.156
    - type: precision_at_3
      value: 36.113
    - type: precision_at_5
      value: 23.71
    - type: recall_at_1
      value: 68.232
    - type: recall_at_10
      value: 93.30199999999999
    - type: recall_at_100
      value: 98.799
    - type: recall_at_1000
      value: 99.885
    - type: recall_at_3
      value: 84.827
    - type: recall_at_5
      value: 89.188
  - task:
      type: Clustering
    dataset:
      type: mteb/reddit-clustering
      name: MTEB RedditClustering
      config: default
      split: test
      revision: 24640382cdbf8abc73003fb0fa6d111a705499eb
    metrics:
    - type: v_measure
      value: 45.71879170816294
  - task:
      type: Clustering
    dataset:
      type: mteb/reddit-clustering-p2p
      name: MTEB RedditClusteringP2P
      config: default
      split: test
      revision: 282350215ef01743dc01b456c7f5241fa8937f16
    metrics:
    - type: v_measure
      value: 59.65866311751794
  - task:
      type: Retrieval
    dataset:
      type: scidocs
      name: MTEB SCIDOCS
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 4.218
    - type: map_at_10
      value: 10.337
    - type: map_at_100
      value: 12.131
    - type: map_at_1000
      value: 12.411
    - type: map_at_3
      value: 7.4270000000000005
    - type: map_at_5
      value: 8.913
    - type: mrr_at_1
      value: 20.8
    - type: mrr_at_10
      value: 30.868000000000002
    - type: mrr_at_100
      value: 31.903
    - type: mrr_at_1000
      value: 31.972
    - type: mrr_at_3
      value: 27.367
    - type: mrr_at_5
      value: 29.372
    - type: ndcg_at_1
      value: 20.8
    - type: ndcg_at_10
      value: 17.765
    - type: ndcg_at_100
      value: 24.914
    - type: ndcg_at_1000
      value: 30.206
    - type: ndcg_at_3
      value: 16.64
    - type: ndcg_at_5
      value: 14.712
    - type: precision_at_1
      value: 20.8
    - type: precision_at_10
      value: 9.24
    - type: precision_at_100
      value: 1.9560000000000002
    - type: precision_at_1000
      value: 0.32299999999999995
    - type: precision_at_3
      value: 15.467
    - type: precision_at_5
      value: 12.94
    - type: recall_at_1
      value: 4.218
    - type: recall_at_10
      value: 18.752
    - type: recall_at_100
      value: 39.7
    - type: recall_at_1000
      value: 65.57300000000001
    - type: recall_at_3
      value: 9.428
    - type: recall_at_5
      value: 13.133000000000001
  - task:
      type: STS
    dataset:
      type: mteb/sickr-sts
      name: MTEB SICK-R
      config: default
      split: test
      revision: a6ea5a8cab320b040a23452cc28066d9beae2cee
    metrics:
    - type: cos_sim_pearson
      value: 83.04338850207233
    - type: cos_sim_spearman
      value: 78.5054651430423
    - type: euclidean_pearson
      value: 80.30739451228612
    - type: euclidean_spearman
      value: 78.48377464299097
    - type: manhattan_pearson
      value: 80.40795049052781
    - type: manhattan_spearman
      value: 78.49506205443114
  - task:
      type: STS
    dataset:
      type: mteb/sts12-sts
      name: MTEB STS12
      config: default
      split: test
      revision: a0d554a64d88156834ff5ae9920b964011b16384
    metrics:
    - type: cos_sim_pearson
      value: 84.11596224442962
    - type: cos_sim_spearman
      value: 76.20997388935461
    - type: euclidean_pearson
      value: 80.56858451349109
    - type: euclidean_spearman
      value: 75.92659183871186
    - type: manhattan_pearson
      value: 80.60246102203844
    - type: manhattan_spearman
      value: 76.03018971432664
  - task:
      type: STS
    dataset:
      type: mteb/sts13-sts
      name: MTEB STS13
      config: default
      split: test
      revision: 7e90230a92c190f1bf69ae9002b8cea547a64cca
    metrics:
    - type: cos_sim_pearson
      value: 81.34691640755737
    - type: cos_sim_spearman
      value: 82.4018369631579
    - type: euclidean_pearson
      value: 81.87673092245366
    - type: euclidean_spearman
      value: 82.3671489960678
    - type: manhattan_pearson
      value: 81.88222387719948
    - type: manhattan_spearman
      value: 82.3816590344736
  - task:
      type: STS
    dataset:
      type: mteb/sts14-sts
      name: MTEB STS14
      config: default
      split: test
      revision: 6031580fec1f6af667f0bd2da0a551cf4f0b2375
    metrics:
    - type: cos_sim_pearson
      value: 81.2836092579524
    - type: cos_sim_spearman
      value: 78.99982781772064
    - type: euclidean_pearson
      value: 80.5184271010527
    - type: euclidean_spearman
      value: 78.89777392101904
    - type: manhattan_pearson
      value: 80.53585705018664
    - type: manhattan_spearman
      value: 78.92898405472994
  - task:
      type: STS
    dataset:
      type: mteb/sts15-sts
      name: MTEB STS15
      config: default
      split: test
      revision: ae752c7c21bf194d8b67fd573edf7ae58183cbe3
    metrics:
    - type: cos_sim_pearson
      value: 86.7349907750784
    - type: cos_sim_spearman
      value: 87.7611234446225
    - type: euclidean_pearson
      value: 86.98759326731624
    - type: euclidean_spearman
      value: 87.58321319424618
    - type: manhattan_pearson
      value: 87.03483090370842
    - type: manhattan_spearman
      value: 87.63278333060288
  - task:
      type: STS
    dataset:
      type: mteb/sts16-sts
      name: MTEB STS16
      config: default
      split: test
      revision: 4d8694f8f0e0100860b497b999b3dbed754a0513
    metrics:
    - type: cos_sim_pearson
      value: 81.75873694924825
    - type: cos_sim_spearman
      value: 83.80237999094724
    - type: euclidean_pearson
      value: 83.55023725861537
    - type: euclidean_spearman
      value: 84.12744338577744
    - type: manhattan_pearson
      value: 83.58816983036232
    - type: manhattan_spearman
      value: 84.18520748676501
  - task:
      type: STS
    dataset:
      type: mteb/sts17-crosslingual-sts
      name: MTEB STS17 (en-en)
      config: en-en
      split: test
      revision: af5e6fb845001ecf41f4c1e033ce921939a2a68d
    metrics:
    - type: cos_sim_pearson
      value: 87.21630882940174
    - type: cos_sim_spearman
      value: 87.72382883437031
    - type: euclidean_pearson
      value: 88.69933350930333
    - type: euclidean_spearman
      value: 88.24660814383081
    - type: manhattan_pearson
      value: 88.77331018833499
    - type: manhattan_spearman
      value: 88.26109989380632
  - task:
      type: STS
    dataset:
      type: mteb/sts22-crosslingual-sts
      name: MTEB STS22 (en)
      config: en
      split: test
      revision: 6d1ba47164174a496b7fa5d3569dae26a6813b80
    metrics:
    - type: cos_sim_pearson
      value: 61.11854063060489
    - type: cos_sim_spearman
      value: 63.14678634195072
    - type: euclidean_pearson
      value: 61.679090067000864
    - type: euclidean_spearman
      value: 62.28876589509653
    - type: manhattan_pearson
      value: 62.082324165511004
    - type: manhattan_spearman
      value: 62.56030932816679
  - task:
      type: STS
    dataset:
      type: mteb/stsbenchmark-sts
      name: MTEB STSBenchmark
      config: default
      split: test
      revision: b0fddb56ed78048fa8b90373c8a3cfc37b684831
    metrics:
    - type: cos_sim_pearson
      value: 84.00319882832645
    - type: cos_sim_spearman
      value: 85.94529772647257
    - type: euclidean_pearson
      value: 85.6661390122756
    - type: euclidean_spearman
      value: 85.97747815545827
    - type: manhattan_pearson
      value: 85.58422770541893
    - type: manhattan_spearman
      value: 85.9237139181532
  - task:
      type: Reranking
    dataset:
      type: mteb/scidocs-reranking
      name: MTEB SciDocsRR
      config: default
      split: test
      revision: d3c5e1fc0b855ab6097bf1cda04dd73947d7caab
    metrics:
    - type: map
      value: 79.16198731863916
    - type: mrr
      value: 94.25202702163487
  - task:
      type: Retrieval
    dataset:
      type: scifact
      name: MTEB SciFact
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 54.761
    - type: map_at_10
      value: 64.396
    - type: map_at_100
      value: 65.07
    - type: map_at_1000
      value: 65.09899999999999
    - type: map_at_3
      value: 61.846000000000004
    - type: map_at_5
      value: 63.284
    - type: mrr_at_1
      value: 57.667
    - type: mrr_at_10
      value: 65.83099999999999
    - type: mrr_at_100
      value: 66.36800000000001
    - type: mrr_at_1000
      value: 66.39399999999999
    - type: mrr_at_3
      value: 64.056
    - type: mrr_at_5
      value: 65.206
    - type: ndcg_at_1
      value: 57.667
    - type: ndcg_at_10
      value: 68.854
    - type: ndcg_at_100
      value: 71.59100000000001
    - type: ndcg_at_1000
      value: 72.383
    - type: ndcg_at_3
      value: 64.671
    - type: ndcg_at_5
      value: 66.796
    - type: precision_at_1
      value: 57.667
    - type: precision_at_10
      value: 9.167
    - type: precision_at_100
      value: 1.053
    - type: precision_at_1000
      value: 0.11199999999999999
    - type: precision_at_3
      value: 25.444
    - type: precision_at_5
      value: 16.667
    - type: recall_at_1
      value: 54.761
    - type: recall_at_10
      value: 80.9
    - type: recall_at_100
      value: 92.767
    - type: recall_at_1000
      value: 99
    - type: recall_at_3
      value: 69.672
    - type: recall_at_5
      value: 75.083
  - task:
      type: PairClassification
    dataset:
      type: mteb/sprintduplicatequestions-pairclassification
      name: MTEB SprintDuplicateQuestions
      config: default
      split: test
      revision: d66bd1f72af766a5cc4b0ca5e00c162f89e8cc46
    metrics:
    - type: cos_sim_accuracy
      value: 99.8079207920792
    - type: cos_sim_ap
      value: 94.88470927617445
    - type: cos_sim_f1
      value: 90.08179959100204
    - type: cos_sim_precision
      value: 92.15481171548117
    - type: cos_sim_recall
      value: 88.1
    - type: dot_accuracy
      value: 99.58613861386138
    - type: dot_ap
      value: 82.94822578881316
    - type: dot_f1
      value: 77.33333333333333
    - type: dot_precision
      value: 79.36842105263158
    - type: dot_recall
      value: 75.4
    - type: euclidean_accuracy
      value: 99.8069306930693
    - type: euclidean_ap
      value: 94.81367858031837
    - type: euclidean_f1
      value: 90.01009081735621
    - type: euclidean_precision
      value: 90.83503054989816
    - type: euclidean_recall
      value: 89.2
    - type: manhattan_accuracy
      value: 99.81188118811882
    - type: manhattan_ap
      value: 94.91405337220161
    - type: manhattan_f1
      value: 90.2763561924258
    - type: manhattan_precision
      value: 92.45283018867924
    - type: manhattan_recall
      value: 88.2
    - type: max_accuracy
      value: 99.81188118811882
    - type: max_ap
      value: 94.91405337220161
    - type: max_f1
      value: 90.2763561924258
  - task:
      type: Clustering
    dataset:
      type: mteb/stackexchange-clustering
      name: MTEB StackExchangeClustering
      config: default
      split: test
      revision: 6cbc1f7b2bc0622f2e39d2c77fa502909748c259
    metrics:
    - type: v_measure
      value: 58.511599500053094
  - task:
      type: Clustering
    dataset:
      type: mteb/stackexchange-clustering-p2p
      name: MTEB StackExchangeClusteringP2P
      config: default
      split: test
      revision: 815ca46b2622cec33ccafc3735d572c266efdb44
    metrics:
    - type: v_measure
      value: 31.984728147814707
  - task:
      type: Reranking
    dataset:
      type: mteb/stackoverflowdupquestions-reranking
      name: MTEB StackOverflowDupQuestions
      config: default
      split: test
      revision: e185fbe320c72810689fc5848eb6114e1ef5ec69
    metrics:
    - type: map
      value: 49.93428193939015
    - type: mrr
      value: 50.916557911043206
  - task:
      type: Summarization
    dataset:
      type: mteb/summeval
      name: MTEB SummEval
      config: default
      split: test
      revision: cda12ad7615edc362dbf25a00fdd61d3b1eaf93c
    metrics:
    - type: cos_sim_pearson
      value: 31.562500894537145
    - type: cos_sim_spearman
      value: 31.162587976726307
    - type: dot_pearson
      value: 22.633662187735762
    - type: dot_spearman
      value: 22.723000282378962
  - task:
      type: Retrieval
    dataset:
      type: trec-covid
      name: MTEB TRECCOVID
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 0.219
    - type: map_at_10
      value: 1.871
    - type: map_at_100
      value: 10.487
    - type: map_at_1000
      value: 25.122
    - type: map_at_3
      value: 0.657
    - type: map_at_5
      value: 1.0699999999999998
    - type: mrr_at_1
      value: 84
    - type: mrr_at_10
      value: 89.567
    - type: mrr_at_100
      value: 89.748
    - type: mrr_at_1000
      value: 89.748
    - type: mrr_at_3
      value: 88.667
    - type: mrr_at_5
      value: 89.567
    - type: ndcg_at_1
      value: 80
    - type: ndcg_at_10
      value: 74.533
    - type: ndcg_at_100
      value: 55.839000000000006
    - type: ndcg_at_1000
      value: 49.748
    - type: ndcg_at_3
      value: 79.53099999999999
    - type: ndcg_at_5
      value: 78.245
    - type: precision_at_1
      value: 84
    - type: precision_at_10
      value: 78.4
    - type: precision_at_100
      value: 56.99999999999999
    - type: precision_at_1000
      value: 21.98
    - type: precision_at_3
      value: 85.333
    - type: precision_at_5
      value: 84.8
    - type: recall_at_1
      value: 0.219
    - type: recall_at_10
      value: 2.02
    - type: recall_at_100
      value: 13.555
    - type: recall_at_1000
      value: 46.739999999999995
    - type: recall_at_3
      value: 0.685
    - type: recall_at_5
      value: 1.13
  - task:
      type: Retrieval
    dataset:
      type: webis-touche2020
      name: MTEB Touche2020
      config: default
      split: test
      revision: None
    metrics:
    - type: map_at_1
      value: 3.5029999999999997
    - type: map_at_10
      value: 11.042
    - type: map_at_100
      value: 16.326999999999998
    - type: map_at_1000
      value: 17.836
    - type: map_at_3
      value: 6.174
    - type: map_at_5
      value: 7.979
    - type: mrr_at_1
      value: 42.857
    - type: mrr_at_10
      value: 52.617000000000004
    - type: mrr_at_100
      value: 53.351000000000006
    - type: mrr_at_1000
      value: 53.351000000000006
    - type: mrr_at_3
      value: 46.939
    - type: mrr_at_5
      value: 50.714000000000006
    - type: ndcg_at_1
      value: 38.775999999999996
    - type: ndcg_at_10
      value: 27.125
    - type: ndcg_at_100
      value: 35.845
    - type: ndcg_at_1000
      value: 47.377
    - type: ndcg_at_3
      value: 29.633
    - type: ndcg_at_5
      value: 28.378999999999998
    - type: precision_at_1
      value: 42.857
    - type: precision_at_10
      value: 24.082
    - type: precision_at_100
      value: 6.877999999999999
    - type: precision_at_1000
      value: 1.463
    - type: precision_at_3
      value: 29.932
    - type: precision_at_5
      value: 28.571
    - type: recall_at_1
      value: 3.5029999999999997
    - type: recall_at_10
      value: 17.068
    - type: recall_at_100
      value: 43.361
    - type: recall_at_1000
      value: 78.835
    - type: recall_at_3
      value: 6.821000000000001
    - type: recall_at_5
      value: 10.357
  - task:
      type: Classification
    dataset:
      type: mteb/toxic_conversations_50k
      name: MTEB ToxicConversationsClassification
      config: default
      split: test
      revision: d7c0de2777da35d6aae2200a62c6e0e5af397c4c
    metrics:
    - type: accuracy
      value: 71.0954
    - type: ap
      value: 14.216844153511959
    - type: f1
      value: 54.63687418565117
  - task:
      type: Classification
    dataset:
      type: mteb/tweet_sentiment_extraction
      name: MTEB TweetSentimentExtractionClassification
      config: default
      split: test
      revision: d604517c81ca91fe16a244d1248fc021f9ecee7a
    metrics:
    - type: accuracy
      value: 61.46293152235427
    - type: f1
      value: 61.744177921638645
  - task:
      type: Clustering
    dataset:
      type: mteb/twentynewsgroups-clustering
      name: MTEB TwentyNewsgroupsClustering
      config: default
      split: test
      revision: 6125ec4e24fa026cec8a478383ee943acfbd5449
    metrics:
    - type: v_measure
      value: 41.12708617788644
  - task:
      type: PairClassification
    dataset:
      type: mteb/twittersemeval2015-pairclassification
      name: MTEB TwitterSemEval2015
      config: default
      split: test
      revision: 70970daeab8776df92f5ea462b6173c0b46fd2d1
    metrics:
    - type: cos_sim_accuracy
      value: 85.75430649102938
    - type: cos_sim_ap
      value: 73.34252536948081
    - type: cos_sim_f1
      value: 67.53758935173774
    - type: cos_sim_precision
      value: 63.3672525439408
    - type: cos_sim_recall
      value: 72.29551451187335
    - type: dot_accuracy
      value: 81.71305954580676
    - type: dot_ap
      value: 59.5532209082386
    - type: dot_f1
      value: 56.18466898954705
    - type: dot_precision
      value: 47.830923248053395
    - type: dot_recall
      value: 68.07387862796834
    - type: euclidean_accuracy
      value: 85.81987244441795
    - type: euclidean_ap
      value: 73.34325409809446
    - type: euclidean_f1
      value: 67.83451360417443
    - type: euclidean_precision
      value: 64.09955388588871
    - type: euclidean_recall
      value: 72.0316622691293
    - type: manhattan_accuracy
      value: 85.68277999642368
    - type: manhattan_ap
      value: 73.1535450121903
    - type: manhattan_f1
      value: 67.928237896289
    - type: manhattan_precision
      value: 63.56945722171113
    - type: manhattan_recall
      value: 72.9287598944591
    - type: max_accuracy
      value: 85.81987244441795
    - type: max_ap
      value: 73.34325409809446
    - type: max_f1
      value: 67.928237896289
  - task:
      type: PairClassification
    dataset:
      type: mteb/twitterurlcorpus-pairclassification
      name: MTEB TwitterURLCorpus
      config: default
      split: test
      revision: 8b6510b0b1fa4e4c4f879467980e9be563ec1cdf
    metrics:
    - type: cos_sim_accuracy
      value: 88.90441262079403
    - type: cos_sim_ap
      value: 85.79331880741438
    - type: cos_sim_f1
      value: 78.31563529842548
    - type: cos_sim_precision
      value: 74.6683424102779
    - type: cos_sim_recall
      value: 82.33754234678165
    - type: dot_accuracy
      value: 84.89928978926534
    - type: dot_ap
      value: 75.25819218316
    - type: dot_f1
      value: 69.88730119720536
    - type: dot_precision
      value: 64.23362374959665
    - type: dot_recall
      value: 76.63227594702803
    - type: euclidean_accuracy
      value: 89.01695967710637
    - type: euclidean_ap
      value: 85.98986606038852
    - type: euclidean_f1
      value: 78.5277880014722
    - type: euclidean_precision
      value: 75.22211253701876
    - type: euclidean_recall
      value: 82.13735756082538
    - type: manhattan_accuracy
      value: 88.99561454573679
    - type: manhattan_ap
      value: 85.92262421793953
    - type: manhattan_f1
      value: 78.38866094740769
    - type: manhattan_precision
      value: 76.02373028505282
    - type: manhattan_recall
      value: 80.9054511857099
    - type: max_accuracy
      value: 89.01695967710637
    - type: max_ap
      value: 85.98986606038852
    - type: max_f1
      value: 78.5277880014722
language:
- en
license: mit
---

# E5-small-v2

[Text Embeddings by Weakly-Supervised Contrastive Pre-training](https://arxiv.org/pdf/2212.03533.pdf).
Liang Wang, Nan Yang, Xiaolong Huang, Binxing Jiao, Linjun Yang, Daxin Jiang, Rangan Majumder, Furu Wei, arXiv 2022

This model has 12 layers and the embedding size is 384.

## Usage

Below is an example to encode queries and passages from the MS-MARCO passage ranking dataset.

```python
import torch.nn.functional as F

from torch import Tensor
from transformers import AutoTokenizer, AutoModel


def average_pool(last_hidden_states: Tensor,
                 attention_mask: Tensor) -> Tensor:
    last_hidden = last_hidden_states.masked_fill(~attention_mask[..., None].bool(), 0.0)
    return last_hidden.sum(dim=1) / attention_mask.sum(dim=1)[..., None]


# Each input text should start with "query: " or "passage: ".
# For tasks other than retrieval, you can simply use the "query: " prefix.
input_texts = ['query: how much protein should a female eat',
               'query: summit define',
               "passage: As a general guideline, the CDC's average requirement of protein for women ages 19 to 70 is 46 grams per day. But, as you can see from this chart, you'll need to increase that if you're expecting or training for a marathon. Check out the chart below to see how much protein you should be eating each day.",
               "passage: Definition of summit for English Language Learners. : 1  the highest point of a mountain : the top of a mountain. : 2  the highest level. : 3  a meeting or series of meetings between the leaders of two or more governments."]

tokenizer = AutoTokenizer.from_pretrained('intfloat/e5-small-v2')
model = AutoModel.from_pretrained('intfloat/e5-small-v2')

# Tokenize the input texts
batch_dict = tokenizer(input_texts, max_length=512, padding=True, truncation=True, return_tensors='pt')

outputs = model(**batch_dict)
embeddings = average_pool(outputs.last_hidden_state, batch_dict['attention_mask'])

# normalize embeddings
embeddings = F.normalize(embeddings, p=2, dim=1)
scores = (embeddings[:2] @ embeddings[2:].T) * 100
print(scores.tolist())
```

## Training Details

Please refer to our paper at [https://arxiv.org/pdf/2212.03533.pdf](https://arxiv.org/pdf/2212.03533.pdf).

## Benchmark Evaluation

Check out [unilm/e5](https://github.com/microsoft/unilm/tree/master/e5) to reproduce evaluation results 
on the [BEIR](https://arxiv.org/abs/2104.08663) and [MTEB benchmark](https://arxiv.org/abs/2210.07316).

## Support for Sentence Transformers

Below is an example for usage with sentence_transformers.
```python
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('intfloat/e5-small-v2')
input_texts = [
    'query: how much protein should a female eat',
    'query: summit define',
    "passage: As a general guideline, the CDC's average requirement of protein for women ages 19 to 70 is 46 grams per day. But, as you can see from this chart, you'll need to increase that if you're expecting or training for a marathon. Check out the chart below to see how much protein you should be eating each day.",
    "passage: Definition of summit for English Language Learners. : 1  the highest point of a mountain : the top of a mountain. : 2  the highest level. : 3  a meeting or series of meetings between the leaders of two or more governments."
]
embeddings = model.encode(input_texts, normalize_embeddings=True)
```

Package requirements

`pip install sentence_transformers~=2.2.2`

Contributors: [michaelfeil](https://huggingface.co/michaelfeil)

## FAQ

**1. Do I need to add the prefix "query: " and "passage: " to input texts?**

Yes, this is how the model is trained, otherwise you will see a performance degradation.

Here are some rules of thumb:
- Use "query: " and "passage: " correspondingly for asymmetric tasks such as passage retrieval in open QA, ad-hoc information retrieval.

- Use "query: " prefix for symmetric tasks such as semantic similarity, paraphrase retrieval.

- Use "query: " prefix if you want to use embeddings as features, such as linear probing classification, clustering.

**2. Why are my reproduced results slightly different from reported in the model card?**

Different versions of `transformers` and `pytorch` could cause negligible but non-zero performance differences.

**3. Why does the cosine similarity scores distribute around 0.7 to 1.0?**

This is a known and expected behavior as we use a low temperature 0.01 for InfoNCE contrastive loss. 

For text embedding tasks like text retrieval or semantic similarity, 
what matters is the relative order of the scores instead of the absolute values, 
so this should not be an issue.

## Citation

If you find our paper or models helpful, please consider cite as follows:

```
@article{wang2022text,
  title={Text Embeddings by Weakly-Supervised Contrastive Pre-training},
  author={Wang, Liang and Yang, Nan and Huang, Xiaolong and Jiao, Binxing and Yang, Linjun and Jiang, Daxin and Majumder, Rangan and Wei, Furu},
  journal={arXiv preprint arXiv:2212.03533},
  year={2022}
}
```

## Limitations

This model only works for English texts. Long texts will be truncated to at most 512 tokens.

