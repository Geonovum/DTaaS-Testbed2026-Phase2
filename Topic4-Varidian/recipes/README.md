# Recipes in WDL format

We have 3 different recipes in here, subsidence, expert and guided analysis.

Under the hood the recipes use the scripts we added in the lib
directory. These recipes are added to show how we used the WDL language.

## Subsidence analysis

[Subsidence analysis](./subsidence_analysis.wdl)

The calculation and threshold in one. 

## Expert site analysis

[Expert site analysis](./expert_site_analysis.wdl)

The calculation with retrieving the groundwater level. This recipe requires
expert knowledge to configure the site analysis.

## Guided site analysis

[Soil guided site analysis](./soil_guided_site_analysis.wdl)

The wrapped site analysis with expert settings applied. All that is left to
do is to define the area to find land to develop on.
